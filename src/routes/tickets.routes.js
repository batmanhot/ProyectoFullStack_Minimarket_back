import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

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
    return reply.send({ data: tickets, meta: { total: tickets.length } })
  })

  // GET /api/tickets/validate/:code  — validar sin marcar como usado
  fastify.get('/tickets/validate/:code', { preHandler: PRE }, async (req, reply) => {
    const ticket = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: req.params.code.toUpperCase() } },
    })
    if (!ticket)          return reply.code(404).send({ error: 'Código de descuento no encontrado' })
    if (!ticket.isActive) return reply.code(409).send({ error: 'El código de descuento está inactivo' })
    if (ticket.used)      return reply.code(409).send({ error: 'Este código ya fue utilizado' })
    if (ticket.validTo && new Date(ticket.validTo) < new Date()) {
      return reply.code(409).send({ error: 'El código de descuento ha vencido' })
    }
    return reply.send({ data: ticket })
  })

  fastify.post('/tickets', { preHandler: PRE }, async (req, reply) => {
    const parsed = ticketSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const existing = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: parsed.data.code } },
    })
    if (existing) return reply.code(409).send({ error: `El código "${parsed.data.code}" ya existe` })

    const ticket = await prisma.discountTicket.create({
      data: {
        ...parsed.data,
        tenantId:  req.tenantId,
        validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : null,
        validTo:   parsed.data.validTo   ? new Date(parsed.data.validTo)   : null,
      },
    })
    return reply.code(201).send({ data: ticket })
  })

  fastify.put('/tickets/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountTicket.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return reply.code(404).send({ error: 'Ticket no encontrado' })
    const data = { ...req.body }
    if (data.code)      data.code     = data.code.toUpperCase()
    if (data.validFrom) data.validFrom = new Date(data.validFrom)
    if (data.validTo)   data.validTo   = new Date(data.validTo)
    const ticket = await prisma.discountTicket.update({ where: { id: req.params.id }, data })
    return reply.send({ data: ticket })
  })

  fastify.delete('/tickets/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountTicket.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return reply.code(404).send({ error: 'Ticket no encontrado' })
    await prisma.discountTicket.delete({ where: { id: req.params.id } })
    return reply.send({ data: { id: req.params.id, deleted: true } })
  })

  // POST /api/tickets/:code/redeem  — marcar como usado al confirmar venta
  fastify.post('/tickets/:code/redeem', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({ saleId: z.string(), saleTotal: z.number(), userId: z.string().optional() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos' })

    const ticket = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: req.params.code.toUpperCase() } },
    })
    if (!ticket)          return reply.code(404).send({ error: 'Código no encontrado' })
    if (!ticket.isActive) return reply.code(409).send({ error: 'Código inactivo' })
    if (ticket.used)      return reply.code(409).send({ error: 'Código ya utilizado' })

    const updated = await prisma.discountTicket.update({
      where: { id: ticket.id },
      data:  { used: true, usedAt: new Date(), usedBySaleId: parsed.data.saleId },
    })
    return reply.send({ data: { code: updated.code, saleId: parsed.data.saleId, redeemed: true } })
  })
}
