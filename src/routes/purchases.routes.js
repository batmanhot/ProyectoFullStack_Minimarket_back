import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]
const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

export default async function purchasesRoutes(fastify) {

  // GET /api/purchases
  fastify.get('/purchases', { preHandler: PRE }, async (req, reply) => {
    const { status, supplierId, page = '1', limit = '100' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const where = {
      tenantId: req.tenantId,
      ...(status     && { status }),
      ...(supplierId && { supplierId }),
    }
    const [purchases, total] = await Promise.all([
      prisma.purchase.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { items: true, supplier: { select: { name: true } } },
      }),
      prisma.purchase.count({ where }),
    ])
    return sendOk(reply, purchases, { total })
  })

  // GET /api/purchases/:id
  fastify.get('/purchases/:id', { preHandler: PRE }, async (req, reply) => {
    const purchase = await prisma.purchase.findFirst({
      where:   { id: req.params.id, tenantId: req.tenantId },
      include: {
        items:    true,
        supplier: { select: { name: true, ruc: true, phone: true, email: true } },
        user:     { select: { fullName: true, username: true } },
      },
    })
    if (!purchase) return send404(reply, 'Compra')
    return sendOk(reply, purchase)
  })

  // POST /api/purchases
  fastify.post('/purchases', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      supplierId:   z.string().uuid().optional(),
      supplierName: z.string().default(''),
      notes:        z.string().default(''),
      items: z.array(z.object({
        productId:   z.string(),
        quantity:    z.number().positive(),
        priceBuy:    z.number().min(0),
        batchNumber: z.string().optional(),
        expiryDate:  z.string().optional(),
      })).min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')
    const d = parsed.data

    const total = HALF_UP(d.items.reduce((s, i) => s + i.quantity * i.priceBuy, 0))

    const purchase = await prisma.$transaction(async (tx) => {
      const newPurchase = await tx.purchase.create({
        data: {
          tenantId:     req.tenantId,
          supplierId:   d.supplierId || null,
          supplierName: d.supplierName,
          status:       'confirmada',
          total,
          userId:       req.user.id,
          notes:        d.notes,
          items: {
            create: d.items.map(i => ({
              productId: i.productId,
              quantity:  i.quantity,
              priceBuy:  i.priceBuy,
              total:     HALF_UP(i.quantity * i.priceBuy),
            })),
          },
        },
        include: { items: true },
      })

      for (const item of d.items) {
        const product = await tx.product.findFirst({
          where:   { id: item.productId, tenantId: req.tenantId },
          include: { batches: true },
        })
        if (!product) continue

        const prevStock = product.stock
        const newStock  = prevStock + item.quantity

        if ((product.stockControl === 'lote_fefo' || product.stockControl === 'lote_fifo') && item.batchNumber) {
          const existingBatch = product.batches.find(b => b.number === item.batchNumber)
          if (existingBatch) {
            await tx.productBatch.update({
              where: { id: existingBatch.id },
              data:  { quantity: existingBatch.quantity + item.quantity, status: 'activo' },
            })
          } else {
            await tx.productBatch.create({
              data: {
                productId:  product.id,
                number:     item.batchNumber,
                quantity:   item.quantity,
                expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
                status:     'activo',
              },
            })
          }
        }

        await tx.product.update({
          where: { id: product.id },
          data:  { stock: newStock, priceBuy: item.priceBuy },
        })

        await tx.stockMovement.create({
          data: {
            tenantId:      req.tenantId,
            productId:     product.id,
            productName:   product.name,
            type:          'entrada',
            quantity:      item.quantity,
            previousStock: prevStock,
            newStock,
            reason:        `Compra ${newPurchase.id.slice(0, 8)}`,
            userId:        req.user.id,
          },
        })
      }

      return newPurchase
    })

    return sendOk(reply, purchase, null, 201)
  })

  // PATCH /api/purchases/:id/status
  fastify.patch('/purchases/:id/status', { preHandler: PRE }, async (req, reply) => {
    const { status } = req.body
    if (!['confirmada', 'recibida', 'anulada'].includes(status)) {
      return sendError(reply, 'Estado inválido. Use: confirmada | recibida | anulada')
    }

    const existing = await prisma.purchase.findFirst({
      where:   { id: req.params.id, tenantId: req.tenantId },
      include: { items: true },
    })
    if (!existing)                    return send404(reply, 'Compra')
    if (existing.status === 'anulada') return send409(reply, 'Esta compra ya está anulada')

    if (status === 'anulada') {
      await prisma.$transaction(async (tx) => {
        for (const item of existing.items) {
          const product = await tx.product.findFirst({
            where:   { id: item.productId },
            include: { batches: true },
          })
          if (!product) continue

          const prevStock = product.stock
          const newStock  = Math.max(0, prevStock - item.quantity)

          await tx.product.update({
            where: { id: product.id },
            data:  { stock: newStock },
          })

          await tx.stockMovement.create({
            data: {
              tenantId:      req.tenantId,
              productId:     product.id,
              productName:   product.name,
              type:          'salida',
              quantity:      item.quantity,
              previousStock: prevStock,
              newStock,
              reason:        `Anulación compra ${existing.id.slice(0, 8)}`,
              userId:        req.user.id,
            },
          })
        }

        await tx.purchase.update({ where: { id: existing.id }, data: { status } })
      })
    } else {
      await prisma.purchase.update({ where: { id: existing.id }, data: { status } })
    }

    return sendOk(reply, { id: existing.id, status })
  })
}
