import { z }    from 'zod'
import prisma    from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

const toDto = (r) => ({
  id: r.id, productId: r.productId, productName: r.productName,
  batchId: r.batchId, quantity: r.quantity, unit: r.unit,
  reason: r.reason, status: r.status, notes: r.notes,
  costUnit: r.costUnit, userId: r.userId, userName: r.userName,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
})

export default async function mermaRoutes(fastify) {

  // GET /api/merma
  fastify.get('/merma', { preHandler: PRE }, async (req, reply) => {
    const { search, status, reason, from, to } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(status && { status }),
      ...(reason && { reason }),
      ...(from || to) && {
        createdAt: {
          ...(from && { gte: new Date(from) }),
          ...(to   && { lte: new Date(to)   }),
        },
      },
      ...(search && {
        OR: [
          { productName: { contains: search, mode: 'insensitive' } },
          { notes:       { contains: search, mode: 'insensitive' } },
        ],
      }),
    }
    const records = await prisma.mermaRecord.findMany({ where, orderBy: { createdAt: 'desc' } })
    const total   = records.reduce((s, r) => s + r.quantity, 0)
    const cost    = records.reduce((s, r) => s + r.quantity * r.costUnit, 0)
    return sendOk(reply, records.map(toDto), { total: records.length, totalUnits: total, totalCost: parseFloat(cost.toFixed(2)) })
  })

  // POST /api/merma  — registrar merma y descontar stock
  fastify.post('/merma', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      productId: z.string().uuid(),
      batchId:   z.string().default(''),
      quantity:  z.number().positive(),
      reason:    z.enum(['vencido', 'dañado', 'hurto', 'otro']),
      notes:     z.string().default(''),
      costUnit:  z.number().min(0).default(0),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const product = await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId: req.tenantId } })
    if (!product) return send404(reply, 'Producto')

    const user = req.user

    const [record] = await prisma.$transaction([
      prisma.mermaRecord.create({
        data: {
          tenantId:    req.tenantId,
          productId:   parsed.data.productId,
          productName: product.name,
          batchId:     parsed.data.batchId,
          quantity:    parsed.data.quantity,
          unit:        product.unit,
          reason:      parsed.data.reason,
          notes:       parsed.data.notes,
          costUnit:    parsed.data.costUnit,
          userId:      user?.id   || '',
          userName:    user?.fullName || user?.username || '',
        },
      }),
      prisma.product.update({
        where: { id: parsed.data.productId },
        data: { stock: { decrement: parsed.data.quantity } },
      }),
      prisma.stockMovement.create({
        data: {
          tenantId:      req.tenantId,
          productId:     parsed.data.productId,
          productName:   product.name,
          type:          'salida',
          quantity:      parsed.data.quantity,
          previousStock: product.stock,
          newStock:      product.stock - parsed.data.quantity,
          reason:        `Merma: ${parsed.data.reason}`,
          userId:        user?.id || '',
        },
      }),
    ])

    return sendOk(reply, toDto(record), null, 201)
  })

  // PATCH /api/merma/:id/status — cambiar estado (devuelto/repuesto)
  fastify.patch('/merma/:id/status', { preHandler: PRE }, async (req, reply) => {
    const { status } = req.body
    if (!['en_merma', 'devuelto', 'repuesto'].includes(status)) {
      return sendError(reply, 'Estado inválido. Use: en_merma | devuelto | repuesto')
    }
    const record = await prisma.mermaRecord.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!record) return send404(reply, 'Registro de merma')

    const updated = await prisma.mermaRecord.update({ where: { id: record.id }, data: { status, updatedAt: new Date() } })
    return sendOk(reply, toDto(updated))
  })
}
