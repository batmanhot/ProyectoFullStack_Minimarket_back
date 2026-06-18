import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404 } from '../utils/response.js'

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
    return sendOk(reply, suppliers, { total: suppliers.length })
  })

  fastify.post('/suppliers', { preHandler: PRE }, async (req, reply) => {
    const parsed = supplierSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')
    const supplier = await prisma.supplier.create({ data: { ...parsed.data, tenantId: req.tenantId } })
    return sendOk(reply, supplier, null, 201)
  })

  fastify.put('/suppliers/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Proveedor')
    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data: req.body })
    return sendOk(reply, supplier)
  })

  fastify.delete('/suppliers/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Proveedor')
    await prisma.supplier.update({ where: { id: req.params.id }, data: { isActive: false } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })
}
