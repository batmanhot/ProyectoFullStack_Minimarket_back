import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

const PRE = [requireAuth, resolveTenant]
const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

export default async function cashRoutes(fastify) {

  // GET /api/cash  — historial de sesiones
  fastify.get('/cash', { preHandler: PRE }, async (req, reply) => {
    const { status, page = '1', limit = '50' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      tenantId: req.tenantId,
      ...(status && { status }),
    }

    const [sessions, total] = await Promise.all([
      prisma.cashSession.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { openedAt: 'desc' },
        include: { user: { select: { fullName: true, username: true } } },
      }),
      prisma.cashSession.count({ where }),
    ])

    return reply.send({ data: sessions, meta: { total } })
  })

  // GET /api/cash/active  — sesión actualmente abierta
  fastify.get('/cash/active', { preHandler: PRE }, async (req, reply) => {
    const session = await prisma.cashSession.findFirst({
      where:   { tenantId: req.tenantId, status: 'abierta' },
      orderBy: { openedAt: 'desc' },
      include: { user: { select: { fullName: true } } },
    })
    return reply.send({ data: session || null })
  })

  // POST /api/cash/open  — apertura de caja
  fastify.post('/cash/open', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      id:            z.string().uuid().optional(),
      openingAmount: z.number().min(0).default(0),
      notes:         z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos' })

    const open = await prisma.cashSession.findFirst({
      where: { tenantId: req.tenantId, status: 'abierta' },
    })
    if (open) return reply.code(409).send({ error: 'Ya existe una caja abierta. Ciérrala antes de abrir una nueva.' })

    const session = await prisma.cashSession.create({
      data: {
        ...(parsed.data.id && { id: parsed.data.id }),
        tenantId:      req.tenantId,
        userId:        req.user.id,
        status:        'abierta',
        openingAmount: parsed.data.openingAmount,  // FIX: campo correcto del schema
        openedAt:      new Date(),
        notes:         parsed.data.notes,
      },
    })
    return reply.code(201).send({ data: session })
  })

  // POST /api/cash/:id/close  — cierre de caja
  fastify.post('/cash/:id/close', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      countedAmount: z.number().min(0),
      notes:         z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Se requiere el monto contado' })

    const session = await prisma.cashSession.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!session) return reply.code(404).send({ error: 'Sesión de caja no encontrada' })
    if (session.status === 'cerrada') return reply.code(409).send({ error: 'Esta caja ya está cerrada' })

    // Calcular totales reales del turno desde la DB
    const salesInSession = await prisma.sale.findMany({
      where: {
        tenantId:  req.tenantId,
        status:    'completada',
        createdAt: { gte: session.openedAt },
      },
      include: { payments: true },
    })

    let totalSales         = 0
    let salesCount         = 0
    let totalDebtCollected = 0
    let debtPaymentsCount  = 0
    let effectiveSales     = 0

    for (const sale of salesInSession) {
      salesCount++
      totalSales += sale.total
      for (const pmt of sale.payments) {
        if (pmt.method === 'credito') {
          totalDebtCollected += pmt.amount
          debtPaymentsCount++
        }
        if (pmt.method === 'efectivo') {
          effectiveSales += pmt.amount
        }
      }
    }

    // FIX: usar session.openingAmount (campo correcto del schema Prisma)
    const expectedAmount = HALF_UP(session.openingAmount + effectiveSales)
    const difference     = HALF_UP(parsed.data.countedAmount - expectedAmount)

    const closed = await prisma.cashSession.update({
      where: { id: session.id },
      data: {
        status:             'cerrada',
        closedAt:           new Date(),
        countedAmount:      parsed.data.countedAmount,  // campo correcto del schema
        expectedAmount,
        difference,
        salesCount,
        totalSales:         HALF_UP(totalSales),
        totalDebtCollected: HALF_UP(totalDebtCollected),
        debtPaymentsCount,
        notes:              parsed.data.notes || session.notes,
      },
    })

    return reply.send({ data: closed })
  })
}
