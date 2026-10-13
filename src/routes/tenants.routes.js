import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth, requireSuperAdmin } from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { registrationRateLimit } from '../middlewares/rateLimit.js'
import { sendOk, sendError, send404 } from '../utils/response.js'

const configSchema = z.object({
  businessName:  z.string().min(1).optional(),
  sector:        z.string().optional(),
  ruc:           z.string().optional(),
  ownerName:     z.string().optional(),
  ownerEmail:    z.string().email().optional(),
  phone:         z.string().optional(),
  emisorId:      z.string().optional(),
}).strict()

const plans = ['trial', 'basic', 'pro', 'enterprise']
const billingCycles = ['monthly', 'quarterly', 'semiannual', 'annual']
const dateSchema = z.string().datetime({ offset: true }).or(z.string().date())

const accessPatchSchema = z.object({
  plan: z.enum(plans).optional(),
  billingCycle: z.enum(billingCycles).optional(),
  accessStartDate: dateSchema.optional(),
  accessExpiresAt: dateSchema.optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
}).strict()

const planConfigUpdateSchema = z.object({
  priceMonthly: z.number().nonnegative().optional(),
  priceQuarterly: z.number().nonnegative().optional(),
  priceSemiannual: z.number().nonnegative().optional(),
  priceAnnual: z.number().nonnegative().optional(),
  products: z.number().int().nonnegative().nullable().optional(),
  users: z.number().int().nonnegative().nullable().optional(),
  warehouses: z.number().int().nonnegative().nullable().optional(),
  suppliers: z.number().int().nonnegative().nullable().optional(),
  customers: z.number().int().nonnegative().nullable().optional(),
  ordersPerMonth: z.number().int().nonnegative().nullable().optional(),
  storageGB: z.number().int().nonnegative().nullable().optional(),
  supportType: z.enum(['none', 'email', 'priority', 'dedicated']).optional(),
  apiAccess: z.boolean().optional(),
  multiCompany: z.boolean().optional(),
  advancedExport: z.boolean().optional(),
  advancedReports: z.boolean().optional(),
  exportData: z.boolean().optional(),
  multiCash: z.boolean().optional(),
}).strict()

const planUpdatesSchema = z.object({
  trial: planConfigUpdateSchema.optional(),
  basic: planConfigUpdateSchema.optional(),
  pro: planConfigUpdateSchema.optional(),
  enterprise: planConfigUpdateSchema.optional(),
}).strict()

const siteSettingsSchema = z.object({
  brandName: z.string().max(120).optional(), tagline: z.string().max(240).optional(),
  description: z.string().max(2000).optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().max(2048).optional(), systemVersion: z.string().max(40).optional(),
  phone: z.string().max(40).optional(), whatsapp: z.string().max(40).optional(),
  email: z.string().email().or(z.literal('')).optional(), address: z.string().max(300).optional(),
  facebook: z.string().max(2048).optional(), instagram: z.string().max(2048).optional(), tiktok: z.string().max(2048).optional(),
  heroTitle: z.string().max(180).optional(), heroSubtitle: z.string().max(500).optional(),
  heroCtaText: z.string().max(80).optional(), heroCtaUrl: z.string().max(2048).optional(),
  heroCtaSecText: z.string().max(80).optional(), heroCtaSecUrl: z.string().max(2048).optional(), heroImage: z.string().max(2048).optional(),
  metaTitle: z.string().max(120).optional(), metaDesc: z.string().max(300).optional(), seoKeywords: z.string().max(500).optional(),
  footerText: z.string().max(500).optional(), showPricesPublic: z.boolean().optional(),
  publicCurrency: z.enum(['PEN', 'USD']).optional(), trialDays: z.number().int().min(1).max(365).optional(), maintenanceMode: z.boolean().optional(),
}).strict()

const alertThresholdSchema = z.object({
  warning: z.number().int().min(1).max(365).optional(),
  urgent: z.number().int().min(1).max(365).optional(),
  critical: z.number().int().min(1).max(365).optional(),
}).strict()

export default async function tenantsRoutes(fastify) {

  // GET /api/tenants/check-slug/:slug  — público (usado en registro)
  fastify.get('/tenants/check-slug/:slug', async (req, reply) => {
    const { slug } = req.params
    const existing = await prisma.tenant.findUnique({ where: { slug } })
    return sendOk(reply, { available: !existing })
  })

  // GET /api/tenants/current — ficha completa del negocio autenticado.
  fastify.get('/tenants/current', { preHandler: [requireAuth, resolveTenant] }, async (req, reply) => {
    if (!req.tenantId) return sendError(reply, 'Esta cuenta no pertenece a un negocio', 400)
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: {
        id: true, slug: true, businessName: true, sector: true,
        ruc: true, ownerName: true, ownerEmail: true, phone: true,
        plan: true, billingCycle: true, accessStartDate: true,
        accessExpiresAt: true, isActive: true, systemVersion: true, emisorId: true,
      },
    })
    if (!tenant) return send404(reply, 'Negocio')
    return sendOk(reply, tenant)
  })

  // GET /api/tenants/:slug — público; solo metadatos necesarios antes del login.
  fastify.get('/tenants/:slug', async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: req.params.slug },
      select: {
        id: true, slug: true, businessName: true, sector: true,
        plan: true, billingCycle: true, accessExpiresAt: true,
        isActive: true, systemVersion: true,
      },
    })
    if (!tenant) return send404(reply, 'Negocio')
    return sendOk(reply, tenant)
  })

  // PATCH /api/tenants/:tenantId/config  — protegida (solo admin del tenant)
  fastify.patch('/tenants/:tenantId/config', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const { tenantId } = req.params

    // Solo el administrador titular puede editar su propio tenant (o superadmin).
    if (req.user.role !== 'superadmin' && req.user.tenantId !== tenantId) {
      return sendError(reply, 'No tienes permiso para modificar este negocio', 403)
    }
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
      return sendError(reply, 'Solo el administrador puede modificar este negocio', 403)
    }

    const parsed = configSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data:  parsed.data,
      select: {
        id: true, slug: true, businessName: true, sector: true,
        ruc: true, ownerName: true, ownerEmail: true, phone: true,
        plan: true, emisorId: true, updatedAt: true,
      },
    })
    return sendOk(reply, updated)
  })

  // POST /api/tenants/register  — público (auto-registro de nuevos negocios)
  fastify.post('/tenants/register', { preHandler: [registrationRateLimit] }, async (req, reply) => {
    const schema = z.object({
      businessName:  z.string().min(2),
      sector:        z.string().min(1),
      ownerName:     z.string().min(2),
      ownerEmail:    z.string().email(),
      phone:         z.string().min(6),
      password:      z.string().min(12).max(128),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }
    const d = parsed.data

    // Generar slug único desde el nombre del negocio
    let baseSlug = d.businessName
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)
    let slug = baseSlug
    let attempt = 0
    while (await prisma.tenant.findUnique({ where: { slug } })) {
      attempt++
      slug = `${baseSlug}-${attempt}`
    }

    // El autorregistro nunca concede planes pagados: su activación solo puede
    // hacerla el superadmin tras confirmar el pago.
    const plan = 'trial'
    const billingCycle = 'monthly'
    const trialDays  = 14
    const days       = trialDays
    const accessStart   = new Date()
    const accessExpires = new Date(accessStart.getTime() + days * 86400_000)

    const { default: bcrypt } = await import('bcryptjs')
    const passwordHash = await bcrypt.hash(d.password, 10)

    const tenant = await prisma.tenant.create({
      data: {
        slug,
        businessName:      d.businessName,
        sector:            d.sector,
        ownerName:         d.ownerName,
        ownerEmail:        d.ownerEmail,
        phone:             d.phone,
        plan,
        billingCycle,
        accessStartDate:   accessStart,
        accessExpiresAt:   accessExpires,
        registrationSource: 'self-service',
        users: {
          create: {
            fullName:     d.ownerName,
            username:     d.ownerEmail,
            passwordHash,
            role:         'admin',
            email:        d.ownerEmail,
          },
        },
      },
      select: {
        id: true, slug: true, businessName: true, plan: true,
        accessStartDate: true, accessExpiresAt: true, ownerEmail: true,
      },
    })

    return sendOk(reply, tenant, null, 201)
  })

  // ── Rutas SuperAdmin ─────────────────────────────────────────────────────────

  // GET /api/admin/tenants
  fastify.get('/admin/tenants', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const { search, page = '1', limit = '20' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = search
      ? {
          OR: [
            { businessName: { contains: search, mode: 'insensitive' } },
            { ownerEmail:   { contains: search, mode: 'insensitive' } },
            { slug:         { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}

    const [items, total] = await Promise.all([
      prisma.tenant.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, slug: true, businessName: true, sector: true,
          ruc: true, ownerName: true, ownerEmail: true, phone: true,
          plan: true, billingCycle: true, internalNotes: true,
          accessStartDate: true, accessExpiresAt: true,
          isActive: true, createdAt: true, registrationSource: true,
        },
      }),
      prisma.tenant.count({ where }),
    ])
    return sendOk(reply, { items, total })
  })

  // POST /api/admin/tenants
  fastify.post('/admin/tenants', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const schema = z.object({
      businessName:  z.string().min(2),
      sector:        z.string().default('bodega'),
      ownerName:     z.string().min(2),
      ownerEmail:    z.string().email(),
      phone:         z.string().default(''),
      password:      z.string().min(12).max(128),
      plan:          z.enum(['trial','basic','pro','enterprise']).default('basic'),
      billingCycle:  z.enum(['monthly','quarterly','semiannual','annual']).default('monthly'),
      internalNotes: z.string().default(''),
      accessStartDate: z.string().optional(),
      accessDays:    z.number().positive().default(30),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }
    const d = parsed.data

    let baseSlug = d.businessName
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)
    let slug = baseSlug
    let attempt = 0
    while (await prisma.tenant.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${++attempt}`
    }

    const { default: bcrypt } = await import('bcryptjs')
    const passwordHash  = await bcrypt.hash(d.password, 10)
    const accessStart   = d.accessStartDate ? new Date(d.accessStartDate) : new Date()
    const accessExpires = new Date(accessStart.getTime() + d.accessDays * 86400_000)

    const tenant = await prisma.tenant.create({
      data: {
        slug, businessName: d.businessName, sector: d.sector,
        ownerName: d.ownerName, ownerEmail: d.ownerEmail, phone: d.phone,
        plan: d.plan, billingCycle: d.billingCycle,
        accessStartDate: accessStart, accessExpiresAt: accessExpires,
        internalNotes: d.internalNotes,
        registrationSource: 'superadmin',
        users: {
          create: { fullName: d.ownerName, username: d.ownerEmail, passwordHash, role: 'admin', email: d.ownerEmail },
        },
      },
    })
    return sendOk(reply, tenant, null, 201)
  })

  // PATCH /api/admin/tenants/:tenantId
  fastify.patch('/admin/tenants/:tenantId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const schema = z.object({
      businessName:    z.string().optional(),
      sector:          z.string().optional(),
      ruc:             z.string().optional(),
      ownerName:       z.string().optional(),
      ownerEmail:      z.string().email().optional(),
      phone:           z.string().optional(),
      plan:            z.enum(['trial','basic','pro','enterprise']).optional(),
      billingCycle:    z.enum(['monthly','quarterly','semiannual','annual']).optional(),
      isActive:        z.boolean().optional(),
      accessStartDate: z.string().optional(),
      accessExpiresAt: z.string().optional(),
      internalNotes:   z.string().optional(),
      emisorId:        z.string().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }
    const d = parsed.data
    const data = { ...d }
    if (d.accessStartDate) data.accessStartDate = new Date(d.accessStartDate)
    if (d.accessExpiresAt) data.accessExpiresAt = new Date(d.accessExpiresAt)
    const updated = await prisma.tenant.update({
      where: { id: req.params.tenantId },
      data,
    })
    return sendOk(reply, updated)
  })

  // DELETE /api/admin/tenants/:tenantId
  fastify.delete('/admin/tenants/:tenantId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await prisma.tenant.delete({ where: { id: req.params.tenantId } })
    return sendOk(reply, null)
  })

  // POST /api/admin/tenants/:tenantId/renew
  fastify.post('/admin/tenants/:tenantId/renew', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const schema = z.object({
      plan:        z.enum(['trial','basic','pro','enterprise']),
      billingCycle:z.enum(['monthly','quarterly','semiannual','annual']),
      startMode:   z.enum(['immediate','expiry']).default('expiry'),
      accessDays:  z.number().positive().default(30),
      notes:       z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }
    const d = parsed.data
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } })
    if (!tenant) return send404(reply, 'Tenant')

    const baseDate = d.startMode === 'expiry' && tenant.accessExpiresAt > new Date()
      ? tenant.accessExpiresAt
      : new Date()
    const newExpiry = new Date(baseDate.getTime() + d.accessDays * 86400_000)

    const [updated, renewal] = await prisma.$transaction([
      prisma.tenant.update({
        where: { id: tenant.id },
        data: { plan: d.plan, billingCycle: d.billingCycle, accessExpiresAt: newExpiry, isActive: true },
      }),
      prisma.renewal.create({
        data: {
          tenantId:       tenant.id,
          plan:           d.plan,
          billingCycle:   d.billingCycle,
          startMode:      d.startMode,
          accessStartDate: baseDate,
          accessExpiresAt: newExpiry,
          notes:          d.notes,
        },
      }),
    ])
    return sendOk(reply, { ...updated, renewal })
  })

  // GET /api/admin/renewals
  fastify.get('/admin/renewals', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const { tenantId } = req.query
    const renewals = await prisma.renewal.findMany({
      where:   tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      include: { tenant: { select: { slug: true, businessName: true } } },
    })
    return sendOk(reply, renewals)
  })

  // GET /api/admin/accesses
  fastify.get('/admin/accesses', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const { tenantId } = req.query
    const accesses = await prisma.access.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      include: { tenant: { select: { slug: true, businessName: true, ownerEmail: true } } },
    })
    return sendOk(reply, accesses, { total: accesses.length })
  })

  // POST /api/admin/accesses
  fastify.post('/admin/accesses', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const schema = z.object({
      tenantId:       z.string().uuid(),
      plan:           z.string(),
      billingCycle:   z.string(),
      accessStartDate:z.string(),
      accessDays:     z.number().positive(),
      notes:          z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')
    const d = parsed.data
    const start  = new Date(d.accessStartDate)
    const expiry = new Date(start.getTime() + d.accessDays * 86400_000)
    const access = await prisma.access.create({
      data: { tenantId: d.tenantId, plan: d.plan, billingCycle: d.billingCycle, accessStartDate: start, accessExpiresAt: expiry, notes: d.notes },
    })
    return sendOk(reply, access, null, 201)
  })

  // PATCH /api/admin/accesses/:accessId
  fastify.patch('/admin/accesses/:accessId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const parsed = accessPatchSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos invÃ¡lidos')
    const data = { ...parsed.data }
    if (data.accessStartDate) data.accessStartDate = new Date(data.accessStartDate)
    if (data.accessExpiresAt) data.accessExpiresAt = new Date(data.accessExpiresAt)
    const access = await prisma.access.update({
      where: { id: req.params.accessId },
      data,
    })
    return sendOk(reply, access)
  })

  // DELETE /api/admin/accesses/:accessId
  fastify.delete('/admin/accesses/:accessId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await prisma.access.delete({ where: { id: req.params.accessId } })
    return sendOk(reply, null)
  })

  // Seed inicial de PlanConfig si la tabla está vacía
  const PLAN_DEFAULTS = {
    trial:      { priceMonthly: 0,   priceQuarterly: 0,   priceSemiannual: 0,   priceAnnual: 0,   products: 50,   users: 1, warehouses: 1, suppliers: 0,  customers: 20,  ordersPerMonth: 50,  storageGB: 0, supportType: 'none',     apiAccess: false, multiCompany: false, advancedExport: false, advancedReports: false, exportData: false, multiCash: false },
    basic:      { priceMonthly: 49,  priceQuarterly: 130, priceSemiannual: 240, priceAnnual: 450, products: 500,  users: 2, warehouses: 1, suppliers: 5,  customers: 100, ordersPerMonth: 200, storageGB: 1, supportType: 'email',    apiAccess: false, multiCompany: false, advancedExport: false, advancedReports: false, exportData: true,  multiCash: false },
    pro:        { priceMonthly: 99,  priceQuarterly: 270, priceSemiannual: 510, priceAnnual: 950, products: 2000, users: 5, warehouses: 2, suppliers: 20, customers: 500, ordersPerMonth: 999, storageGB: 5, supportType: 'priority', apiAccess: false, multiCompany: false, advancedExport: true,  advancedReports: true,  exportData: true,  multiCash: true  },
    enterprise: { priceMonthly: 199, priceQuarterly: 540, priceSemiannual: 999, priceAnnual: 1890, products: null, users: null, warehouses: null, suppliers: null, customers: null, ordersPerMonth: null, storageGB: 20, supportType: 'dedicated', apiAccess: true, multiCompany: true, advancedExport: true, advancedReports: true, exportData: true, multiCash: true },
  }

  const _ensurePlanConfigs = async () => {
    const count = await prisma.planConfig.count()
    if (count === 0) {
      await Promise.all(
        Object.entries(PLAN_DEFAULTS).map(([plan, data]) =>
          prisma.planConfig.upsert({ where: { plan }, create: { plan, ...data }, update: data })
        )
      )
    }
  }

  // GET/PUT /api/admin/prices
  fastify.get('/admin/prices', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await _ensurePlanConfigs()
    const configs = await prisma.planConfig.findMany({ orderBy: { plan: 'asc' } })
    const prices = Object.fromEntries(configs.map(c => [c.plan, c]))
    return sendOk(reply, prices)
  })

  fastify.put('/admin/prices', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const parsed = planUpdatesSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos invÃ¡lidos')
    const updates = Object.entries(parsed.data).filter(([, data]) => data !== undefined)
    await Promise.all(updates.map(([plan, data]) =>
      prisma.planConfig.upsert({
        where:  { plan },
        create: { plan, ...data },
        update: data,
      })
    ))
    const configs = await prisma.planConfig.findMany()
    return sendOk(reply, Object.fromEntries(configs.map(c => [c.plan, c])))
  })

  // GET/PUT /api/admin/plan-limits
  fastify.get('/admin/plan-limits', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await _ensurePlanConfigs()
    const configs = await prisma.planConfig.findMany()
    return sendOk(reply, Object.fromEntries(configs.map(c => [c.plan, c])))
  })

  fastify.put('/admin/plan-limits', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const parsed = planUpdatesSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos invÃ¡lidos')
    const updates = Object.entries(parsed.data).filter(([, data]) => data !== undefined)
    await Promise.all(updates.map(([plan, data]) =>
      prisma.planConfig.upsert({
        where: { plan }, create: { plan, ...data }, update: data,
      })
    ))
    const configs = await prisma.planConfig.findMany()
    return sendOk(reply, Object.fromEntries(configs.map(c => [c.plan, c])))
  })

  // GET/PUT /api/admin/site-settings
  fastify.get('/admin/site-settings', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const settings = await prisma.siteSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    })
    return sendOk(reply, settings)
  })

  fastify.put('/admin/site-settings', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const parsed = siteSettingsSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos invÃ¡lidos')
    const settings = await prisma.siteSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...parsed.data },
      update: parsed.data,
    })
    return sendOk(reply, settings)
  })

  // GET/PUT /api/admin/alert-thresholds
  fastify.get('/admin/alert-thresholds', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const thresholds = await prisma.alertThreshold.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    })
    return sendOk(reply, thresholds)
  })

  fastify.put('/admin/alert-thresholds', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const parsed = alertThresholdSchema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos invÃ¡lidos')
    const thresholds = await prisma.alertThreshold.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...parsed.data },
      update: parsed.data,
    })
    return sendOk(reply, thresholds)
  })

  // GET /api/admin/login-events  — historial de inicios de sesión de todos los tenants
  fastify.get('/admin/login-events', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const { tenantId, limit = '100', offset = '0' } = req.query
    const where = tenantId ? { tenantId } : {}
    const [items, total] = await Promise.all([
      prisma.loginEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
        include: { tenant: { select: { businessName: true, slug: true } } },
      }),
      prisma.loginEvent.count({ where }),
    ])
    return sendOk(reply, { items, total })
  })

  // DELETE /api/admin/login-events/:id
  fastify.delete('/admin/login-events/:id', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await prisma.loginEvent.delete({ where: { id: req.params.id } })
    return sendOk(reply, null)
  })
}
