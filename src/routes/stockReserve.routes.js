/**
 * stockReserve.routes.js
 * Reserva atómica de stock para multi-caja.
 *
 * Flujo:
 *  POST /api/stock-reserve       → reserva ítems del carrito (TTL 10 min)
 *  DELETE /api/stock-reserve/:id → libera la reserva (al cancelar o al completar venta)
 *  GET /api/stock-reserve/active → lista reservas activas del tenant
 *
 * Estrategia:
 *  - Se descuenta stock "disponible" virtualmente en memoria de PostgreSQL
 *    usando una tabla stock_reserves.
 *  - El campo `product.stock` NO se toca hasta que la venta se confirma.
 *  - allocateStock en ventas.routes.js debe restar SOLO el stock no reservado
 *    por OTROS cajeros (la reserva propia se convierte en venta).
 *  - Un job de limpieza (cleanExpiredReserves) debe correr periódicamente;
 *    aquí lo llamamos en cada GET para no requerir cron/BullMQ en esta fase.
 */
import { z }           from 'zod'
import prisma          from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

const PRE      = [requireAuth, resolveTenant]
const TTL_MS   = 10 * 60 * 1000   // 10 minutos
const HALF_UP  = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

// ── Limpia reservas expiradas del tenant ──────────────────────────────────────
async function cleanExpiredReserves(tenantId) {
  await prisma.stockReserve.deleteMany({
    where: { tenantId, expiresAt: { lt: new Date() } },
  })
}

// ── Stock disponible = stock real − reservas activas de OTROS cajeros ─────────
async function getAvailableStock(tenantId, productId, excludeReserveId = null) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId },
  })
  if (!product) return 0

  const reservedByOthers = await prisma.stockReserve.aggregate({
    where: {
      tenantId,
      productId,
      expiresAt: { gt: new Date() },
      ...(excludeReserveId && { id: { not: excludeReserveId } }),
    },
    _sum: { quantity: true },
  })

  const reserved = reservedByOthers._sum.quantity || 0
  return Math.max(0, product.stock - reserved)
}

export default async function stockReserveRoutes(fastify) {

  // POST /api/stock-reserve — crea o renueva una reserva de carrito
  fastify.post('/stock-reserve', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      reserveId: z.string().uuid().optional(), // si viene, renueva la reserva existente
      items: z.array(z.object({
        productId: z.string().uuid(),
        quantity:  z.number().positive(),
      })).min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    const { reserveId, items } = parsed.data
    const tenantId = req.tenantId
    const userId   = req.user.id
    const expiresAt = new Date(Date.now() + TTL_MS)

    await cleanExpiredReserves(tenantId)

    // Verificar disponibilidad de cada ítem antes de reservar
    const conflicts = []
    for (const item of items) {
      const available = await getAvailableStock(
        tenantId,
        item.productId,
        reserveId || undefined   // excluir la reserva propia si se está renovando
      )
      if (available < item.quantity) {
        const product = await prisma.product.findFirst({
          where:  { id: item.productId, tenantId },
          select: { name: true, stock: true },
        })
        conflicts.push({
          productId:  item.productId,
          productName:product?.name || item.productId,
          requested:  item.quantity,
          available,
        })
      }
    }

    if (conflicts.length > 0) {
      return reply.code(409).send({
        error:     'Stock insuficiente para completar la reserva',
        conflicts,
      })
    }

    // Upsert atómico: crea o renueva la reserva
    if (reserveId) {
      // Renovar reserva existente
      const existing = await prisma.stockReserve.findFirst({
        where: { id: reserveId, tenantId },
      })
      if (!existing) {
        return reply.code(404).send({ error: 'Reserva no encontrada' })
      }

      // Eliminar ítems anteriores y reemplazar
      await prisma.$transaction([
        prisma.stockReserveItem.deleteMany({ where: { reserveId } }),
        ...items.map(item =>
          prisma.stockReserveItem.create({ data: { reserveId, ...item } })
        ),
        prisma.stockReserve.update({
          where: { id: reserveId },
          data:  { expiresAt, updatedAt: new Date() },
        }),
      ])

      const reserve = await prisma.stockReserve.findUnique({
        where:   { id: reserveId },
        include: { items: true },
      })
      return reply.send({ data: reserve })
    }

    // Crear reserva nueva
    const reserve = await prisma.stockReserve.create({
      data: {
        tenantId,
        userId,
        expiresAt,
        items: { create: items },
      },
      include: { items: true },
    })

    return reply.code(201).send({ data: reserve })
  })

  // DELETE /api/stock-reserve/:id — libera la reserva (cancelar carrito o venta completada)
  fastify.delete('/stock-reserve/:id', { preHandler: PRE }, async (req, reply) => {
    const reserve = await prisma.stockReserve.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!reserve) {
      // Si ya no existe (expiró o fue eliminada), responder OK igualmente
      return reply.send({ data: { id: req.params.id, released: true } })
    }

    await prisma.stockReserve.delete({ where: { id: reserve.id } })
    return reply.send({ data: { id: reserve.id, released: true } })
  })

  // GET /api/stock-reserve/active — reservas activas del tenant (para debug/monitor)
  fastify.get('/stock-reserve/active', { preHandler: PRE }, async (req, reply) => {
    await cleanExpiredReserves(req.tenantId)

    const reserves = await prisma.stockReserve.findMany({
      where:   { tenantId: req.tenantId, expiresAt: { gt: new Date() } },
      include: {
        items: {
          include: {
            product: { select: { name: true, stock: true } },
          },
        },
        user: { select: { fullName: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return reply.send({ data: reserves, meta: { total: reserves.length } })
  })

  // GET /api/stock-reserve/available/:productId — stock disponible de un producto
  fastify.get('/stock-reserve/available/:productId', { preHandler: PRE }, async (req, reply) => {
    const { excludeReserveId } = req.query
    await cleanExpiredReserves(req.tenantId)

    const available = await getAvailableStock(
      req.tenantId,
      req.params.productId,
      excludeReserveId || undefined
    )

    const product = await prisma.product.findFirst({
      where:  { id: req.params.productId, tenantId: req.tenantId },
      select: { id: true, name: true, stock: true },
    })
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' })

    return reply.send({ data: { ...product, available } })
  })
}
