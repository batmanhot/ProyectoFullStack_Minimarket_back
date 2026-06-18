import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

const ticketSchema = z.object({
  code:      z.string().min(3).toUpperCase(),
  discount:  z.number().min(0).max(100),
  minAmount: z.number().min(0).default(0),
  validFrom: z.string().optional(),
  validTo:   z.string().optional(),
  isActive:  z.boolean().default(true),
})

export default async function ticketsRoutes(fastify) {

  fastify.get('/tickets', { preHandler: PRE }, async (req, reply) => {
    const { used, isActive } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(used     !== undefined && { used:     used === 'true' }),
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
    }
    const tickets = await prisma.discountTicket.findMany({ where, orderBy: { createdAt: 'desc' } })
    return sendOk(reply, tickets, { total: tickets.length })
  })

  // GET /api/tickets/validate/:code  — valida sin marcar como usado
  fastify.get('/tickets/validate/:code', { preHandler: PRE }, async (req, reply) => {
    const ticket = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: req.params.code.toUpperCase() } },
    })
    if (!ticket)          return send404(reply, 'Código de descuento')
    if (!ticket.isActive) return send409(reply, 'El código de descuento está inactivo')
    if (ticket.used)      return send409(reply, 'Este código ya fue utilizado')
    if (ticket.validTo && new Date(ticket.validTo) < new Date()) {
      return send409(reply, 'El código de descuento ha vencido')
    }
    return sendOk(reply, ticket)
  })

  fastify.post('/tickets', { preHandler: PRE }, async (req, reply) => {
    const parsed = ticketSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const existing = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: parsed.data.code } },
    })
    if (existing) return send409(reply, `El código "${parsed.data.code}" ya existe`)

    const ticket = await prisma.discountTicket.create({
      data: {
        ...parsed.data,
        tenantId:  req.tenantId,
        validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : null,
        validTo:   parsed.data.validTo   ? new Date(parsed.data.validTo)   : null,
      },
    })
    return sendOk(reply, ticket, null, 201)
  })

  fastify.put('/tickets/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountTicket.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Ticket')
    const data = { ...req.body }
    if (data.code)      data.code      = data.code.toUpperCase()
    if (data.validFrom) data.validFrom = new Date(data.validFrom)
    if (data.validTo)   data.validTo   = new Date(data.validTo)
    const ticket = await prisma.discountTicket.update({ where: { id: req.params.id }, data })
    return sendOk(reply, ticket)
  })

  fastify.delete('/tickets/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountTicket.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Ticket')
    await prisma.discountTicket.delete({ where: { id: req.params.id } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })

  // POST /api/tickets/:code/redeem  — marcar como usado al confirmar venta
  fastify.post('/tickets/:code/redeem', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({ saleId: z.string(), saleTotal: z.number(), userId: z.string().optional() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const ticket = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: req.params.code.toUpperCase() } },
    })
    if (!ticket)          return send404(reply, 'Código')
    if (!ticket.isActive) return send409(reply, 'Código inactivo')
    if (ticket.used)      return send409(reply, 'Código ya utilizado')

    const updated = await prisma.discountTicket.update({
      where: { id: ticket.id },
      data:  { used: true, usedAt: new Date(), usedBySaleId: parsed.data.saleId },
    })
    return sendOk(reply, { code: updated.code, saleId: parsed.data.saleId, redeemed: true })
  })
}
