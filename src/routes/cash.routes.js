import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

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

    return sendOk(reply, sessions, { total })
  })

  // GET /api/cash/active  — sesión actualmente abierta
  fastify.get('/cash/active', { preHandler: PRE }, async (req, reply) => {
    const session = await prisma.cashSession.findFirst({
      where:   { tenantId: req.tenantId, status: 'abierta' },
      orderBy: { openedAt: 'desc' },
      include: { user: { select: { fullName: true } } },
    })
    return sendOk(reply, session || null)
  })

  // POST /api/cash/open  — apertura de caja
  fastify.post('/cash/open', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      id:            z.string().uuid().optional(),
      openingAmount: z.number().min(0).default(0),
      notes:         z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const open = await prisma.cashSession.findFirst({
      where: { tenantId: req.tenantId, status: 'abierta' },
    })
    if (open) return send409(reply, 'Ya existe una caja abierta. Ciérrala antes de abrir una nueva.')

    const session = await prisma.cashSession.create({
      data: {
        ...(parsed.data.id && { id: parsed.data.id }),
        tenantId:      req.tenantId,
        userId:        req.user.id,
        status:        'abierta',
        openingAmount: parsed.data.openingAmount,
        openedAt:      new Date(),
        notes:         parsed.data.notes,
      },
    })
    return sendOk(reply, session, null, 201)
  })

  // POST /api/cash/:id/close  — cierre de caja
  fastify.post('/cash/:id/close', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      countedAmount: z.number().min(0),
      notes:         z.string().default(''),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Se requiere el monto contado')

    const session = await prisma.cashSession.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!session) return send404(reply, 'Sesión de caja')
    if (session.status === 'cerrada') return send409(reply, 'Esta caja ya está cerrada')

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

    const expectedAmount = HALF_UP(session.openingAmount + effectiveSales)
    const difference     = HALF_UP(parsed.data.countedAmount - expectedAmount)

    const closed = await prisma.cashSession.update({
      where: { id: session.id },
      data: {
        status:             'cerrada',
        closedAt:           new Date(),
        countedAmount:      parsed.data.countedAmount,
        expectedAmount,
        difference,
        salesCount,
        totalSales:         HALF_UP(totalSales),
        totalDebtCollected: HALF_UP(totalDebtCollected),
        debtPaymentsCount,
        notes:              parsed.data.notes || session.notes,
      },
    })

    return sendOk(reply, closed)
  })
}
