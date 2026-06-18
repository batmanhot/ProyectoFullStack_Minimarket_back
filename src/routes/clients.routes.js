import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

const clientSchema = z.object({
  name:           z.string().min(1),
  documentType:   z.enum(['DNI','RUC','Pasaporte','CE']).default('DNI'),
  documentNumber: z.string().min(1),
  email:          z.string().email().optional().or(z.literal('')).default(''),
  phone:          z.string().default(''),
  address:        z.string().default(''),
  creditLimit:    z.number().min(0).default(0),
  isActive:       z.boolean().default(true),
})

export default async function clientsRoutes(fastify) {

  // GET /api/clients
  fastify.get('/clients', { preHandler: PRE }, async (req, reply) => {
    const { search, page = '1', limit = '200' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      tenantId: req.tenantId,
      isActive: true,
      ...(search && {
        OR: [
          { name:           { contains: search, mode: 'insensitive' } },
          { documentNumber: { contains: search } },
          { email:          { contains: search, mode: 'insensitive' } },
          { phone:          { contains: search } },
        ],
      }),
    }

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { name: 'asc' },
        include: { loyaltyTransactions: { orderBy: { createdAt: 'desc' }, take: 20 } },
      }),
      prisma.client.count({ where }),
    ])

    return sendOk(reply, clients, { total })
  })

  // GET /api/clients/:id
  fastify.get('/clients/:id', { preHandler: PRE }, async (req, reply) => {
    const client = await prisma.client.findFirst({
      where:   { id: req.params.id, tenantId: req.tenantId },
      include: { loyaltyTransactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
    })
    if (!client) return send404(reply, 'Cliente')
    return sendOk(reply, client)
  })

  // POST /api/clients
  fastify.post('/clients', { preHandler: PRE }, async (req, reply) => {
    const parsed = clientSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const existing = await prisma.client.findUnique({
      where: { tenantId_documentNumber: { tenantId: req.tenantId, documentNumber: parsed.data.documentNumber } },
    })
    if (existing) return send409(reply, `Ya existe un cliente con documento ${parsed.data.documentNumber}`)

    const client = await prisma.client.create({
      data: { ...parsed.data, tenantId: req.tenantId },
    })
    return sendOk(reply, client, null, 201)
  })

  // PUT /api/clients/:id
  fastify.put('/clients/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Cliente')

    // Campos permitidos para actualizar (excluir puntos y deuda — se manejan por lógica de ventas)
    const {
      name, documentType, documentNumber, email, phone, address,
      creditLimit, isActive,
      // Campos de lealtad que puede venir desde el frontend al sincronizar
      loyaltyPoints, loyaltyAccumulated, loyaltyLevel, currentDebt,
    } = req.body

    const client = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        ...(name               !== undefined && { name }),
        ...(documentType       !== undefined && { documentType }),
        ...(documentNumber     !== undefined && { documentNumber }),
        ...(email              !== undefined && { email }),
        ...(phone              !== undefined && { phone }),
        ...(address            !== undefined && { address }),
        ...(creditLimit        !== undefined && { creditLimit }),
        ...(isActive           !== undefined && { isActive }),
        ...(loyaltyPoints      !== undefined && { loyaltyPoints }),
        ...(loyaltyAccumulated !== undefined && { loyaltyAccumulated }),
        ...(loyaltyLevel       !== undefined && { loyaltyLevel }),
        ...(currentDebt        !== undefined && { currentDebt }),
      },
    })
    return sendOk(reply, client)
  })

  // DELETE /api/clients/:id  (soft delete)
  fastify.delete('/clients/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Cliente')
    await prisma.client.update({ where: { id: req.params.id }, data: { isActive: false } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })
}
