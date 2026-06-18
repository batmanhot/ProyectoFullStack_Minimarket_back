import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, send404 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

// Acepta los type names del frontend: campaign | promotion | volume | line
const VALID_TYPES = ['campaign', 'promotion', 'volume', 'line', 'porcentaje', 'monto_fijo', 'compra_lleva', 'bogo']

const campaignSchema = z.object({
  name:          z.string().min(1, 'El nombre es requerido'),
  type:          z.string().refine(v => VALID_TYPES.includes(v), { message: 'Tipo de campaña inválido' }),
  icon:          z.string().default('🏷️'),
  description:   z.string().default(''),
  // Descuento — acepta discountPct (frontend) o discount (legacy)
  discountPct:   z.number().min(0).optional(),
  discount:      z.number().min(0).optional(),
  discountAmount:z.number().min(0).default(0),
  minAmount:     z.number().min(0).default(0),
  maxDiscount:   z.number().min(0).default(0),
  // Alcance — acepta scope (frontend) o applicableTo (legacy)
  scope:         z.string().default('all'),
  applicableTo:  z.string().optional(),
  productIds:    z.array(z.string()).default([]),
  categoryIds:   z.array(z.string()).default([]),
  brands:        z.array(z.string()).default([]),
  daysOfWeek:    z.array(z.number()).default([]),
  // NxM
  buyQty:        z.number().int().min(0).default(0),
  payQty:        z.number().int().min(0).default(0),
  maxPerPurchase:z.number().int().min(0).default(0),
  // Compra X
  minQty:        z.number().int().min(0).default(0),
  discountOnNth: z.number().int().min(0).default(0),
  // Fechas — acepta dateFrom/dateTo (frontend) o validFrom/validTo (legacy)
  dateFrom:      z.string().optional(),
  dateTo:        z.string().optional(),
  validFrom:     z.string().optional(),
  validTo:       z.string().optional(),
  isActive:      z.boolean().default(true),
}).refine(d => d.dateFrom || d.validFrom, { message: 'Fecha de inicio requerida',  path: ['dateFrom'] })
  .refine(d => d.dateTo   || d.validTo,   { message: 'Fecha de término requerida', path: ['dateTo']   })

const campaignUpdateSchema = z.object({
  name:          z.string().min(1).optional(),
  type:          z.string().refine(v => VALID_TYPES.includes(v)).optional(),
  icon:          z.string().optional(),
  description:   z.string().optional(),
  discountPct:   z.number().min(0).optional(),
  discount:      z.number().min(0).optional(),
  discountAmount:z.number().min(0).optional(),
  minAmount:     z.number().min(0).optional(),
  maxDiscount:   z.number().min(0).optional(),
  scope:         z.string().optional(),
  applicableTo:  z.string().optional(),
  productIds:    z.array(z.string()).optional(),
  categoryIds:   z.array(z.string()).optional(),
  brands:        z.array(z.string()).optional(),
  daysOfWeek:    z.array(z.number()).optional(),
  buyQty:        z.number().int().min(0).optional(),
  payQty:        z.number().int().min(0).optional(),
  maxPerPurchase:z.number().int().min(0).optional(),
  minQty:        z.number().int().min(0).optional(),
  discountOnNth: z.number().int().min(0).optional(),
  dateFrom:      z.string().optional(),
  dateTo:        z.string().optional(),
  validFrom:     z.string().optional(),
  validTo:       z.string().optional(),
  isActive:      z.boolean().optional(),
})

function buildCampaignData(d) {
  const vFrom = d.dateFrom || d.validFrom
  const vTo   = d.dateTo   || d.validTo
  return {
    name:          d.name,
    type:          d.type,
    icon:          d.icon          ?? '🏷️',
    description:   d.description   ?? '',
    discount:      d.discountPct   ?? d.discount    ?? 0,
    discountAmount:d.discountAmount ?? 0,
    minAmount:     d.minAmount      ?? 0,
    maxDiscount:   d.maxDiscount    ?? 0,
    scope:         d.scope          ?? d.applicableTo ?? 'all',
    applicableTo:  d.applicableTo   ?? d.scope       ?? 'todos',
    productIds:    d.productIds     ?? [],
    categoryIds:   d.categoryIds    ?? [],
    brands:        d.brands         ?? [],
    daysOfWeek:    d.daysOfWeek     ?? [],
    buyQty:        d.buyQty         ?? 0,
    payQty:        d.payQty         ?? 0,
    maxPerPurchase:d.maxPerPurchase  ?? 0,
    minQty:        d.minQty         ?? 0,
    discountOnNth: d.discountOnNth  ?? 0,
    validFrom:     new Date(vFrom),
    validTo:       new Date(vTo),
    isActive:      d.isActive       ?? true,
  }
}

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
    return sendOk(reply, campaigns, { total: campaigns.length })
  })

  fastify.post('/campaigns', { preHandler: PRE }, async (req, reply) => {
    const parsed = campaignSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const campaign = await prisma.discountCampaign.create({
      data: { ...buildCampaignData(parsed.data), tenantId: req.tenantId },
    })
    return sendOk(reply, campaign, null, 201)
  })

  fastify.put('/campaigns/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountCampaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Campaña')

    const parsed = campaignUpdateSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const d = parsed.data
    const updateData = {}
    if (d.name          !== undefined) updateData.name          = d.name
    if (d.type          !== undefined) updateData.type          = d.type
    if (d.icon          !== undefined) updateData.icon          = d.icon
    if (d.description   !== undefined) updateData.description   = d.description
    if (d.discountPct   !== undefined) updateData.discount      = d.discountPct
    else if (d.discount !== undefined) updateData.discount      = d.discount
    if (d.discountAmount!== undefined) updateData.discountAmount= d.discountAmount
    if (d.minAmount     !== undefined) updateData.minAmount     = d.minAmount
    if (d.maxDiscount   !== undefined) updateData.maxDiscount   = d.maxDiscount
    if (d.scope         !== undefined) updateData.scope         = d.scope
    if (d.applicableTo  !== undefined) updateData.applicableTo  = d.applicableTo
    if (d.productIds    !== undefined) updateData.productIds    = d.productIds
    if (d.categoryIds   !== undefined) updateData.categoryIds   = d.categoryIds
    if (d.brands        !== undefined) updateData.brands        = d.brands
    if (d.daysOfWeek    !== undefined) updateData.daysOfWeek    = d.daysOfWeek
    if (d.buyQty        !== undefined) updateData.buyQty        = d.buyQty
    if (d.payQty        !== undefined) updateData.payQty        = d.payQty
    if (d.maxPerPurchase!== undefined) updateData.maxPerPurchase= d.maxPerPurchase
    if (d.minQty        !== undefined) updateData.minQty        = d.minQty
    if (d.discountOnNth !== undefined) updateData.discountOnNth = d.discountOnNth
    if (d.isActive      !== undefined) updateData.isActive      = d.isActive
    const vFrom = d.dateFrom || d.validFrom
    const vTo   = d.dateTo   || d.validTo
    if (vFrom) updateData.validFrom = new Date(vFrom)
    if (vTo)   updateData.validTo   = new Date(vTo)

    const campaign = await prisma.discountCampaign.update({
      where: { id: req.params.id },
      data:  updateData,
    })
    return sendOk(reply, campaign)
  })

  fastify.patch('/campaigns/:id/toggle', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountCampaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Campaña')

    const campaign = await prisma.discountCampaign.update({
      where: { id: req.params.id },
      data:  { isActive: req.body?.isActive ?? !existing.isActive },
    })
    return sendOk(reply, { id: campaign.id, isActive: campaign.isActive })
  })

  fastify.delete('/campaigns/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.discountCampaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Campaña')

    await prisma.discountCampaign.delete({ where: { id: req.params.id } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })
}
