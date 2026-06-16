import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth, requireSuperAdmin } from '../middlewares/auth.js'

const configSchema = z.object({
  businessName:  z.string().min(1).optional(),
  sector:        z.string().optional(),
  ruc:           z.string().optional(),
  ownerName:     z.string().optional(),
  ownerEmail:    z.string().email().optional(),
  phone:         z.string().optional(),
  emisorId:      z.string().optional(),
}).strict()

export default async function tenantsRoutes(fastify) {

  // GET /api/tenants/check-slug/:slug  — público (usado en registro)
  fastify.get('/tenants/check-slug/:slug', async (req, reply) => {
    const { slug } = req.params
    const existing = await prisma.tenant.findUnique({ where: { slug } })
    return reply.send({ data: { available: !existing } })
  })

  // GET /api/tenants/:slug  — público (usado al iniciar sesión para cargar el tenant)
  fastify.get('/tenants/:slug', async (req, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: req.params.slug },
      select: {
        id: true, slug: true, businessName: true, sector: true,
        ruc: true, ownerName: true, ownerEmail: true, phone: true,
        plan: true, billingCycle: true,
        accessStartDate: true, accessExpiresAt: true,
        isActive: true, systemVersion: true, emisorId: true,
        createdAt: true,
      },
    })
    if (!tenant) return reply.code(404).send({ error: 'Negocio no encontrado' })
    return reply.send({ data: tenant })
  })

  // PATCH /api/tenants/:tenantId/config  — protegida (solo admin del tenant)
  fastify.patch('/tenants/:tenantId/config', {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const { tenantId } = req.params

    // Solo puede editar su propio tenant (o superadmin)
    if (req.user.role !== 'superadmin' && req.user.tenantId !== tenantId) {
      return reply.code(403).send({ error: 'No tienes permiso para modificar este negocio' })
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
    return reply.send({ data: updated })
  })

  // POST /api/tenants/register  — público (auto-registro de nuevos negocios)
  fastify.post('/tenants/register', async (req, reply) => {
    const schema = z.object({
      businessName:  z.string().min(2),
      sector:        z.string().min(1),
      ownerName:     z.string().min(2),
      ownerEmail:    z.string().email(),
      phone:         z.string().min(6),
      password:      z.string().min(6),
      plan:          z.enum(['trial', 'basic', 'pro', 'enterprise']).default('trial'),
      billingCycle:  z.enum(['monthly', 'quarterly', 'semiannual', 'annual']).default('monthly'),
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

    // Período de acceso según plan (trial = 14 días)
    const trialDays  = 14
    const planDays   = { monthly: 30, quarterly: 90, semiannual: 180, annual: 365 }
    const days       = d.plan === 'trial' ? trialDays : (planDays[d.billingCycle] || 30)
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
        plan:              d.plan,
        billingCycle:      d.billingCycle,
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

    return reply.code(201).send({ data: tenant })
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
          ownerEmail: true, plan: true, billingCycle: true,
          accessExpiresAt: true, isActive: true, createdAt: true,
          registrationSource: true,
        },
      }),
      prisma.tenant.count({ where }),
    ])
    return reply.send({ data: { items, total } })
  })

  // POST /api/admin/tenants
  fastify.post('/admin/tenants', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const schema = z.object({
      businessName:  z.string().min(2),
      sector:        z.string().default('bodega'),
      ownerName:     z.string().min(2),
      ownerEmail:    z.string().email(),
      phone:         z.string().default(''),
      password:      z.string().min(6),
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
    return reply.code(201).send({ data: tenant })
  })

  // PATCH /api/admin/tenants/:tenantId
  fastify.patch('/admin/tenants/:tenantId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const schema = z.object({
      businessName:  z.string().optional(),
      plan:          z.enum(['trial','basic','pro','enterprise']).optional(),
      billingCycle:  z.enum(['monthly','quarterly','semiannual','annual']).optional(),
      isActive:      z.boolean().optional(),
      internalNotes: z.string().optional(),
      emisorId:      z.string().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }
    const updated = await prisma.tenant.update({
      where: { id: req.params.tenantId },
      data:  parsed.data,
    })
    return reply.send({ data: updated })
  })

  // DELETE /api/admin/tenants/:tenantId
  fastify.delete('/admin/tenants/:tenantId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await prisma.tenant.delete({ where: { id: req.params.tenantId } })
    return reply.send({ data: null })
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
    if (!tenant) return reply.code(404).send({ error: 'Tenant no encontrado' })

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
    return reply.send({ data: { ...updated, renewal } })
  })

  // GET /api/admin/renewals
  fastify.get('/admin/renewals', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const { tenantId } = req.query
    const renewals = await prisma.renewal.findMany({
      where:   tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      include: { tenant: { select: { slug: true, businessName: true } } },
    })
    return reply.send({ data: renewals })
  })

  // GET /api/admin/accesses
  fastify.get('/admin/accesses', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const { tenantId, search } = req.query
    const accesses = await prisma.access.findMany({
      where: tenantId ? { tenantId } : {},
      orderBy: { createdAt: 'desc' },
      include: { tenant: { select: { slug: true, businessName: true, ownerEmail: true } } },
    })
    return reply.send({ data: accesses, total: accesses.length })
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
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos' })
    const d = parsed.data
    const start  = new Date(d.accessStartDate)
    const expiry = new Date(start.getTime() + d.accessDays * 86400_000)
    const access = await prisma.access.create({
      data: { tenantId: d.tenantId, plan: d.plan, billingCycle: d.billingCycle, accessStartDate: start, accessExpiresAt: expiry, notes: d.notes },
    })
    return reply.code(201).send({ data: access })
  })

  // PATCH /api/admin/accesses/:accessId
  fastify.patch('/admin/accesses/:accessId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const access = await prisma.access.update({
      where: { id: req.params.accessId },
      data:  req.body,
    })
    return reply.send({ data: access })
  })

  // DELETE /api/admin/accesses/:accessId
  fastify.delete('/admin/accesses/:accessId', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    await prisma.access.delete({ where: { id: req.params.accessId } })
    return reply.send({ data: null })
  })

  // GET/PUT /api/admin/prices
  fastify.get('/admin/prices', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const configs = await prisma.planConfig.findMany({ orderBy: { plan: 'asc' } })
    const prices = Object.fromEntries(configs.map(c => [c.plan, c]))
    return reply.send({ data: prices })
  })

  fastify.put('/admin/prices', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const updates = Object.entries(req.body)
    await Promise.all(updates.map(([plan, data]) =>
      prisma.planConfig.upsert({
        where:  { plan },
        create: { plan, ...data },
        update: data,
      })
    ))
    const configs = await prisma.planConfig.findMany()
    return reply.send({ data: Object.fromEntries(configs.map(c => [c.plan, c])) })
  })

  // GET/PUT /api/admin/plan-limits
  fastify.get('/admin/plan-limits', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const configs = await prisma.planConfig.findMany()
    return reply.send({ data: Object.fromEntries(configs.map(c => [c.plan, c])) })
  })

  fastify.put('/admin/plan-limits', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const updates = Object.entries(req.body)
    await Promise.all(updates.map(([plan, data]) =>
      prisma.planConfig.upsert({
        where: { plan }, create: { plan, ...data }, update: data,
      })
    ))
    const configs = await prisma.planConfig.findMany()
    return reply.send({ data: Object.fromEntries(configs.map(c => [c.plan, c])) })
  })

  // GET/PUT /api/admin/site-settings
  fastify.get('/admin/site-settings', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const settings = await prisma.siteSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    })
    return reply.send({ data: settings })
  })

  fastify.put('/admin/site-settings', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const settings = await prisma.siteSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...req.body },
      update: req.body,
    })
    return reply.send({ data: settings })
  })

  // GET/PUT /api/admin/alert-thresholds
  fastify.get('/admin/alert-thresholds', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const thresholds = await prisma.alertThreshold.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    })
    return reply.send({ data: thresholds })
  })

  fastify.put('/admin/alert-thresholds', { preHandler: [requireSuperAdmin] }, async (req, reply) => {
    const thresholds = await prisma.alertThreshold.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...req.body },
      update: req.body,
    })
    return reply.send({ data: thresholds })
  })
}
