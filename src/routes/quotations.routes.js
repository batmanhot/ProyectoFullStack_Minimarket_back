import { z }    from 'zod'
import prisma    from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

const toDto = (q) => ({
  id: q.id, number: q.number, clientId: q.clientId, clientName: q.clientName,
  items: q.items, note: q.note, validDays: q.validDays,
  expiresAt: q.expiresAt, total: q.total, status: q.status,
  saleId: q.saleId, userId: q.userId, userName: q.userName,
  createdAt: q.createdAt, updatedAt: q.updatedAt,
})

async function nextQuotationNumber(tenantId) {
  const last = await prisma.quotation.findFirst({
    where:   { tenantId },
    orderBy: { createdAt: 'desc' },
    select:  { number: true },
  })
  if (!last) return 'COT-000001'
  const n = parseInt(last.number.replace('COT-', '')) + 1
  return `COT-${String(n).padStart(6, '0')}`
}

export default async function quotationsRoutes(fastify) {

  // GET /api/quotations
  fastify.get('/quotations', { preHandler: PRE }, async (req, reply) => {
    const { search, status, from, to, limit = '50', page = '1' } = req.query
    const take = Math.min(parseInt(limit) || 50, 200)
    const skip = (parseInt(page) - 1) * take

    const where = {
      tenantId: req.tenantId,
      ...(status && { status }),
      ...((from || to) && {
        createdAt: {
          ...(from && { gte: new Date(from) }),
          ...(to   && { lte: new Date(to)   }),
        },
      }),
      ...(search && {
        OR: [
          { number:     { contains: search, mode: 'insensitive' } },
          { clientName: { contains: search, mode: 'insensitive' } },
          { note:       { contains: search, mode: 'insensitive' } },
        ],
      }),
    }

    const [total, rows] = await Promise.all([
      prisma.quotation.count({ where }),
      prisma.quotation.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    ])
    return sendOk(reply, rows.map(toDto), { total, page: parseInt(page), limit: take })
  })

  // GET /api/quotations/:id
  fastify.get('/quotations/:id', { preHandler: PRE }, async (req, reply) => {
    const q = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!q) return send404(reply, 'Cotización')
    return sendOk(reply, toDto(q))
  })

  // POST /api/quotations
  fastify.post('/quotations', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      clientId:   z.string().default(''),
      clientName: z.string().default('Sin cliente'),
      items:      z.array(z.object({
        productId:   z.string(),
        productName: z.string(),
        barcode:     z.string().default(''),
        unit:        z.string().default('unidad'),
        quantity:    z.number().positive(),
        unitPrice:   z.number().min(0),
        discount:    z.number().min(0).max(100).default(0),
      })).min(1),
      note:      z.string().default(''),
      validDays: z.number().int().min(1).max(365).default(QUOTATION.DEFAULT_VALID_DAYS),
      total:     z.number().min(0),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const user     = req.user
    const number   = await nextQuotationNumber(req.tenantId)
    const expiresAt = new Date(Date.now() + parsed.data.validDays * 86400_000)

    const q = await prisma.quotation.create({
      data: {
        tenantId:   req.tenantId,
        number,
        clientId:   parsed.data.clientId,
        clientName: parsed.data.clientName,
        items:      parsed.data.items,
        note:       parsed.data.note,
        validDays:  parsed.data.validDays,
        expiresAt,
        total:      parsed.data.total,
        userId:     user?.id       || '',
        userName:   user?.fullName || user?.username || '',
      },
    })
    return sendOk(reply, toDto(q), null, 201)
  })

  // PUT /api/quotations/:id — actualiza mientras esté en borrador
  fastify.put('/quotations/:id', { preHandler: PRE }, async (req, reply) => {
    const q = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!q) return send404(reply, 'Cotización')
    if (q.status !== 'borrador') return send409(reply, 'Solo se puede editar una cotización en estado "borrador"')

    const schema = z.object({
      clientId:   z.string().optional(),
      clientName: z.string().optional(),
      items:      z.array(z.any()).min(1).optional(),
      note:       z.string().optional(),
      validDays:  z.number().int().min(1).optional(),
      total:      z.number().min(0).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const updated = await prisma.quotation.update({
      where: { id: q.id },
      data: {
        ...parsed.data,
        ...(parsed.data.validDays && { expiresAt: new Date(Date.now() + parsed.data.validDays * 86400_000) }),
        updatedAt: new Date(),
      },
    })
    return sendOk(reply, toDto(updated))
  })

  // PATCH /api/quotations/:id/status — transiciones de estado
  fastify.patch('/quotations/:id/status', { preHandler: PRE }, async (req, reply) => {
    const { status } = req.body || {}
    const validStatuses = ['borrador', 'enviada', 'aprobada', 'convertida', 'vencida']
    if (!validStatuses.includes(status)) {
      return sendError(reply, `Estado inválido. Use: ${validStatuses.join(' | ')}`)
    }
    const q = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!q) return send404(reply, 'Cotización')

    const updated = await prisma.quotation.update({ where: { id: q.id }, data: { status, updatedAt: new Date() } })
    return sendOk(reply, toDto(updated))
  })

  // DELETE /api/quotations/:id — solo borradores
  fastify.delete('/quotations/:id', { preHandler: PRE }, async (req, reply) => {
    const q = await prisma.quotation.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!q) return send404(reply, 'Cotización')
    if (!['borrador', 'vencida'].includes(q.status)) {
      return send409(reply, 'Solo se pueden eliminar cotizaciones en borrador o vencidas')
    }
    await prisma.quotation.delete({ where: { id: q.id } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })
}
