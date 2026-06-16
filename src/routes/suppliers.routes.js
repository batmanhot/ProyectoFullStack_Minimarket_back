import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

const PRE = [requireAuth, resolveTenant]

const supplierSchema = z.object({
  name:          z.string().min(1),
  contactPerson: z.string().default(''),
  email:         z.string().email().optional().or(z.literal('')).default(''),
  phone:         z.string().default(''),
  address:       z.string().default(''),
  ruc:           z.string().default(''),
  isActive:      z.boolean().default(true),
})

export default async function suppliersRoutes(fastify) {

  fastify.get('/suppliers', { preHandler: PRE }, async (req, reply) => {
    const { search } = req.query
    const where = {
      tenantId: req.tenantId,
      isActive: true,
      ...(search && {
        OR: [
          { name:  { contains: search, mode: 'insensitive' } },
          { ruc:   { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    }
    const suppliers = await prisma.supplier.findMany({ where, orderBy: { name: 'asc' } })
    return reply.send({ data: suppliers, meta: { total: suppliers.length } })
  })

  fastify.post('/suppliers', { preHandler: PRE }, async (req, reply) => {
    const parsed = supplierSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    const supplier = await prisma.supplier.create({ data: { ...parsed.data, tenantId: req.tenantId } })
    return reply.code(201).send({ data: supplier })
  })

  fastify.put('/suppliers/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data: req.body })
    return reply.send({ data: supplier })
  })

  fastify.delete('/suppliers/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    await prisma.supplier.update({ where: { id: req.params.id }, data: { isActive: false } })
    return reply.send({ data: { id: req.params.id, deleted: true } })
  })
}
