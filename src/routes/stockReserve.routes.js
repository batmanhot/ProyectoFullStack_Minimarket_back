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
import { sendOk, send404 } from '../utils/response.js'
import { lockProducts } from '../services/inventory.service.js'

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
// productId vive en StockReserveItem (tabla hija), no en StockReserve.
// Se agrega sobre StockReserveItem filtrando la reserva padre por tenantId/expiresAt.
async function getAvailableStock(db, tenantId, productId, excludeReserveId = null) {
  const product = await db.product.findFirst({
    where: { id: productId, tenantId },
  })
  if (!product) return 0

  const reservedByOthers = await db.stockReserveItem.aggregate({
    where: {
      productId,
      reserve: {
        tenantId,
        expiresAt: { gt: new Date() },
        ...(excludeReserveId && { id: { not: excludeReserveId } }),
      },
    },
    _sum: { quantity: true },
  })

  const reserved = reservedByOthers._sum.quantity || 0
  return Math.max(0, product.stock - reserved)
}

function aggregateItems(items) {
  const quantities = new Map()
  for (const { productId, quantity } of items) {
    quantities.set(productId, (quantities.get(productId) || 0) + quantity)
  }
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }))
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

    const { reserveId } = parsed.data
    const items = aggregateItems(parsed.data.items)
    const tenantId = req.tenantId
    const userId = req.user.id
    const expiresAt = new Date(Date.now() + TTL_MS)

    const result = await prisma.$transaction(async (tx) => {
      await tx.stockReserve.deleteMany({
        where: { tenantId, expiresAt: { lt: new Date() } },
      })

      // Serializa reservas concurrentes del mismo producto antes de validar.
      await lockProducts(tx, tenantId, items.map(item => item.productId))

      if (reserveId) {
        const existing = await tx.stockReserve.findFirst({
          where: { id: reserveId, tenantId, userId },
        })
        if (!existing) return { notFound: true }
      }

      const conflicts = []
      for (const item of items) {
        const available = await getAvailableStock(tx, tenantId, item.productId, reserveId)
        if (available < item.quantity) {
          const product = await tx.product.findFirst({
            where: { id: item.productId, tenantId },
            select: { name: true },
          })
          conflicts.push({
            productId: item.productId,
            productName: product?.name || item.productId,
            requested: item.quantity,
            available,
          })
        }
      }
      if (conflicts.length > 0) return { conflicts }

      if (reserveId) {
        await tx.stockReserveItem.deleteMany({ where: { reserveId } })
        await tx.stockReserveItem.createMany({
          data: items.map(item => ({ reserveId, ...item })),
        })
        return {
          reserve: await tx.stockReserve.update({
            where: { id: reserveId },
            data: { expiresAt, updatedAt: new Date() },
            include: { items: true },
          }),
        }
      }

      return {
        reserve: await tx.stockReserve.create({
          data: { tenantId, userId, expiresAt, items: { create: items } },
          include: { items: true },
        }),
        created: true,
      }
    })

    if (result.notFound) return send404(reply, 'Reserva')
    if (result.conflicts) {
      return reply.code(409).send({
        error: 'Stock insuficiente para completar la reserva',
        conflicts: result.conflicts,
      })
    }
    return sendOk(reply, result.reserve, null, result.created ? 201 : 200)
  })
  // DELETE /api/stock-reserve/:id — libera la reserva (cancelar carrito o venta completada)
  fastify.delete('/stock-reserve/:id', { preHandler: PRE }, async (req, reply) => {
    const reserve = await prisma.stockReserve.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId, userId: req.user.id },
    })
    if (!reserve) {
      // Si ya no existe (expiró o fue eliminada), responder OK igualmente
      return sendOk(reply, { id: req.params.id, released: true })
    }

    await prisma.stockReserve.delete({ where: { id: reserve.id } })
    return sendOk(reply, { id: reserve.id, released: true })
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

    return sendOk(reply, reserves, { total: reserves.length })
  })

  // GET /api/stock-reserve/available/:productId — stock disponible de un producto
  fastify.get('/stock-reserve/available/:productId', { preHandler: PRE }, async (req, reply) => {
    const { excludeReserveId } = req.query
    await cleanExpiredReserves(req.tenantId)

    // Solo la reserva propia puede excluirse del cálculo de disponibilidad.
    const ownReserve = excludeReserveId
      ? await prisma.stockReserve.findFirst({
          where: { id: excludeReserveId, tenantId: req.tenantId, userId: req.user.id },
          select: { id: true },
        })
      : null

    const available = await getAvailableStock(
      prisma,
      req.tenantId,
      req.params.productId,
      ownReserve?.id
    )

    const product = await prisma.product.findFirst({
      where:  { id: req.params.productId, tenantId: req.tenantId },
      select: { id: true, name: true, stock: true },
    })
    if (!product) return send404(reply, 'Producto')

    return sendOk(reply, { ...product, available })
  })
}
