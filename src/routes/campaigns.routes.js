import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

const PRE = [requireAuth, resolveTenant]

const campaignSchema = z.object({
  name:          z.string().min(1),
  type:          z.enum(['porcentaje','monto_fijo','compra_lleva','bogo']),
  discount:      z.number().min(0).default(0),
  discountAmount:z.number().min(0).default(0),
  minAmount:     z.number().min(0).default(0),
  maxDiscount:   z.number().min(0).default(0),
  applicableTo:  z.enum(['todos','categoria','producto']).default('todos'),
  productIds:    z.array(z.string()).default([]),
  categoryIds:   z.array(z.string()).default([]),
  validFrom:     z.string(),
  validTo:       z.string(),
  isActive:      z.boolean().default(true),
})

// FIX: schema de actualización separado con whitelist explícita — evita que campos
// protegidos (id, tenantId, createdAt) lleguen a Prisma en el PUT
const campaignUpdateSchema = z.object({
  name:          z.string().min(1).optional(),
  type:          z.enum(['porcentaje','monto_fijo','compra_lleva','bogo']).optional(),
  discount:      z.number().min(0).optional(),
  discountAmount:z.number().min(0).optional(),
  minAmount:     z.number().min(0).optional(),
  maxDiscount:   z.number().min(0).optional(),
  applicableTo:  z.enum(['todos','categoria','producto']).optional(),
  productIds:    z.array(z.string()).optional(),
  categoryIds:   z.array(z.string()).optional(),
  validFrom:     z.string().optional(),
  validTo:       z.string().optional(),
  isActive:      z.boolean().optional(),
})

export default async function campaignsRoutes(fastify) {

  fastify.get('/campaigns', { preHandler: PRE }, async (req, reply) => {
    const { isActive, type } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(type     && { type }),
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
    }
    const campaigns = await prisma.discountCampaign.findMany({
      where, orderBy: { createdAt: 'desc' },
    })
    return reply.send({ data: campaigns, meta: { total: campaigns.length } })
  })

  fastify.post('/campaigns', { preHandler: PRE }, async (req, reply) => {
    const parsed = campaignSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const campaign = await prisma.discountCampaign.create({
      data: {
        ...parsed.data,
        tenantId: req.tenantId,
        validFrom: new Date(parsed.data.validFrom),
        validTo:   new Date(parsed.data.validTo),
      },
    })
    return reply.code(201).send({ data: campaign })
  })

  // FIX: usar campaignUpdateSchema con whitelist para evitar campos no permitidos en Prisma
  fastify.put('/campaigns/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountCampaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return reply.code(404).send({ error: 'Campaña no encontrada' })

    const parsed = campaignUpdateSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const updateData = { ...parsed.data }
    if (updateData.validFrom) updateData.validFrom = new Date(updateData.validFrom)
    if (updateData.validTo)   updateData.validTo   = new Date(updateData.validTo)

    const campaign = await prisma.discountCampaign.update({
      where: { id: req.params.id },
      data:  updateData,
    })
    return reply.send({ data: campaign })
  })

  fastify.patch('/campaigns/:id/toggle', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountCampaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return reply.code(404).send({ error: 'Campaña no encontrada' })

    const campaign = await prisma.discountCampaign.update({
      where: { id: req.params.id },
      data:  { isActive: req.body?.isActive ?? !existing.isActive },
    })
    return reply.send({ data: { id: campaign.id, isActive: campaign.isActive } })
  })

  fastify.delete('/campaigns/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountCampaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return reply.code(404).send({ error: 'Campaña no encontrada' })

    await prisma.discountCampaign.delete({ where: { id: req.params.id } })
    return reply.send({ data: { id: req.params.id, deleted: true } })
  })
}
