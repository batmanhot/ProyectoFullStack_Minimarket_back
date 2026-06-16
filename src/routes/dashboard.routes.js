import prisma    from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

const PRE = [requireAuth, resolveTenant]

export default async function dashboardRoutes(fastify) {

  // GET /api/dashboard  — KPIs del día para el panel principal
  fastify.get('/dashboard', { preHandler: PRE }, async (req, reply) => {
    const tid = req.tenantId
    const now        = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todayEnd   = new Date(todayStart.getTime() + 86400_000)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [
      salesToday, salesMonth,
      returnsToday,
      clientsTotal, clientsWithDebt,
      productsTotal, lowStock, nearExpiry,
      activeCash, mermaMonth,
      recentSales,
    ] = await Promise.all([
      // Ventas hoy
      prisma.sale.aggregate({
        where: { tenantId: tid, status: 'completada', createdAt: { gte: todayStart, lt: todayEnd } },
        _sum:   { total: true },
        _count: true,
      }),
      // Ventas mes
      prisma.sale.aggregate({
        where: { tenantId: tid, status: 'completada', createdAt: { gte: monthStart } },
        _sum:   { total: true },
        _count: true,
      }),
      // Devoluciones hoy
      prisma.return.aggregate({
        where: { tenantId: tid, status: { not: 'anulada' }, createdAt: { gte: todayStart, lt: todayEnd } },
        _sum:   { totalRefund: true },
        _count: true,
      }),
      // Clientes
      prisma.client.count({ where: { tenantId: tid, isActive: true } }),
      prisma.client.count({ where: { tenantId: tid, isActive: true, currentDebt: { gt: 0 } } }),
      // Productos
      prisma.product.count({ where: { tenantId: tid, isActive: true } }),
      prisma.product.count({ where: { tenantId: tid, isActive: true, stock: { lte: 0 } } }),
      // Próximos a vencer (30 días)
      prisma.productBatch.count({
        where: {
          product:    { tenantId: tid, isActive: true },
          status:     'activo',
          expiryDate: { lte: new Date(Date.now() + 30 * 86400_000) },
        },
      }),
      // FIX: usar openingAmount (campo correcto del schema Prisma CashSession)
      prisma.cashSession.findFirst({
        where:  { tenantId: tid, status: 'abierta' },
        select: { id: true, openingAmount: true, openedAt: true },
      }),
      // Merma del mes
      prisma.mermaRecord.count({ where: { tenantId: tid, createdAt: { gte: monthStart } } }),
      // Últimas 5 ventas
      // FIX: quitar paymentMethod (no existe en Sale — está en SalePayment[])
      prisma.sale.findMany({
        where:   { tenantId: tid, status: 'completada' },
        orderBy: { createdAt: 'desc' },
        take:    5,
        select:  {
          id:            true,
          invoiceNumber: true,
          total:         true,
          clientName:    true,
          createdAt:     true,
          tipoComprobante: true,
          payments:      { select: { method: true, amount: true } },
        },
      }),
    ])

    // Calcular método de pago principal de cada venta reciente
    const ultimasVentas = recentSales.map(s => {
      const mainPayment = s.payments.sort((a, b) => b.amount - a.amount)[0]
      return {
        id:              s.id,
        invoiceNumber:   s.invoiceNumber,
        total:           s.total,
        clientName:      s.clientName,
        createdAt:       s.createdAt,
        tipoComprobante: s.tipoComprobante,
        paymentMethod:   mainPayment?.method || 'efectivo',
      }
    })

    return reply.send({
      data: {
        ventas: {
          hoy: { count: salesToday._count,  total: parseFloat((salesToday._sum.total  || 0).toFixed(2)) },
          mes: { count: salesMonth._count,  total: parseFloat((salesMonth._sum.total  || 0).toFixed(2)) },
        },
        devoluciones: {
          hoy: { count: returnsToday._count, total: parseFloat((returnsToday._sum.totalRefund || 0).toFixed(2)) },
        },
        clientes:  { total: clientsTotal, conDeuda: clientsWithDebt },
        productos: { total: productsTotal, sinStock: lowStock, porVencer: nearExpiry },
        // FIX: usar openingAmount en la respuesta, mantener alias openAmount para compatibilidad frontend
        caja: activeCash
          ? {
              activa:        true,
              id:            activeCash.id,
              openingAmount: activeCash.openingAmount,
              openAmount:    activeCash.openingAmount,  // alias para compatibilidad frontend
              openedAt:      activeCash.openedAt,
            }
          : { activa: false },
        merma:        { mes: mermaMonth },
        ultimasVentas,
      },
    })
  })
}
