import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

const ticketSchema = z.object({
  code:          z.string().min(3).transform(s => s.toUpperCase()),
  // Titular
  holderType:    z.string().default('persona'),
  holderName:    z.string().min(1, 'El nombre del titular es requerido'),
  holderDocType: z.string().default('DNI'),
  holderDoc:     z.string().default(''),
  holderPhone:   z.string().default(''),
  holderEmail:   z.string().default(''),
  // Descuento
  discountType:  z.enum(['pct', 'amount', 'fixed']).default('pct'),
  discountValue: z.number().positive('El valor del descuento debe ser mayor a 0'),
  maxAmount:     z.number().min(0).nullable().optional(),
  minAmount:     z.number().min(0).default(0),
  // Vigencia
  validFrom:     z.string().nullable().optional(),
  validTo:       z.string().nullable().optional(),
  campaignName:  z.string().default(''),
  notes:         z.string().default(''),
  isActive:      z.boolean().default(true),
})

const ticketUpdateSchema = z.object({
  holderType:    z.string().optional(),
  holderName:    z.string().min(1).optional(),
  holderDocType: z.string().optional(),
  holderDoc:     z.string().optional(),
  holderPhone:   z.string().optional(),
  holderEmail:   z.string().optional(),
  discountType:  z.enum(['pct', 'amount', 'fixed']).optional(),
  discountValue: z.number().positive().optional(),
  maxAmount:     z.number().min(0).nullable().optional(),
  minAmount:     z.number().min(0).optional(),
  validFrom:     z.string().nullable().optional(),
  validTo:       z.string().nullable().optional(),
  campaignName:  z.string().optional(),
  notes:         z.string().optional(),
  isActive:      z.boolean().optional(),
  code:          z.string().min(3).transform(s => s.toUpperCase()).optional(),
})

export default async function ticketsRoutes(fastify) {

  // GET /api/tickets
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

  // GET /api/tickets/validate/:code — valida sin marcar como usado
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

  // POST /api/tickets — crear uno o varios tickets (batch si viene quantity > 1)
  fastify.post('/tickets', { preHandler: PRE }, async (req, reply) => {
    const parsed = ticketSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    // Verificar unicidad del código
    const existing = await prisma.discountTicket.findUnique({
      where: { tenantId_code: { tenantId: req.tenantId, code: parsed.data.code } },
    })
    if (existing) return send409(reply, `El código "${parsed.data.code}" ya existe`)

    const ticket = await prisma.discountTicket.create({
      data: {
        ...parsed.data,
        discount:  parsed.data.discountType === 'pct' ? parsed.data.discountValue : 0, // legacy
        tenantId:  req.tenantId,
        validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : null,
        validTo:   parsed.data.validTo   ? new Date(parsed.data.validTo)   : null,
      },
    })
    return sendOk(reply, ticket, null, 201)
  })

  // PUT /api/tickets/:id — actualizar ticket
  fastify.put('/tickets/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountTicket.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Ticket')

    const parsed = ticketUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    const updateData = { ...parsed.data }
    if (updateData.validFrom !== undefined) updateData.validFrom = updateData.validFrom ? new Date(updateData.validFrom) : null
    if (updateData.validTo   !== undefined) updateData.validTo   = updateData.validTo   ? new Date(updateData.validTo)   : null
    // Sincronizar campo legacy
    if (updateData.discountType !== undefined || updateData.discountValue !== undefined) {
      const dtype = updateData.discountType  ?? existing.discountType
      const dval  = updateData.discountValue ?? existing.discountValue
      updateData.discount = dtype === 'pct' ? dval : 0
    }

    const ticket = await prisma.discountTicket.update({
      where: { id: req.params.id },
      data:  { ...updateData, updatedAt: new Date() },
    })
    return sendOk(reply, ticket)
  })

  // DELETE /api/tickets/:id
  fastify.delete('/tickets/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountTicket.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Ticket')
    if (existing.used) return reply.code(409).send({ error: 'No se puede eliminar un ticket ya canjeado' })
    await prisma.discountTicket.delete({ where: { id: req.params.id } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })

  // POST /api/tickets/:code/redeem — marcar como usado al confirmar venta
  fastify.post('/tickets/:code/redeem', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      saleId:          z.string(),
      saleTotal:       z.number(),
      discountApplied: z.number().optional(),
      userId:          z.string().optional(),
    })
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
      data:  {
        used:            true,
        usedAt:          new Date(),
        usedBySaleId:    parsed.data.saleId,
        discountApplied: parsed.data.discountApplied ?? null,
      },
    })
    return sendOk(reply, { code: updated.code, saleId: parsed.data.saleId, redeemed: true })
  })
}
