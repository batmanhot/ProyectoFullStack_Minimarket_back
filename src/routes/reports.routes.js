import prisma    from '../db.js'
import { requireAuth } from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

// FIX: quitamos requireAdmin — reportes accesibles a todos los roles autenticados.
// Si se quiere restringir por rol, hacerlo en el frontend o pasar a requireAdmin solo
// los reportes financieros sensibles (summary, merma).
const PRE = [requireAuth, resolveTenant]

function dateRange(from, to) {
  return {
    ...(from && { gte: new Date(from) }),
    ...(to   && { lte: new Date(to)   }),
  }
}

export default async function reportsRoutes(fastify) {

  // GET /api/reports/summary?from=&to=  — KPIs consolidados de ventas
  fastify.get('/reports/summary', { preHandler: PRE }, async (req, reply) => {
    const { from, to } = req.query
    const createdAt = dateRange(from, to)
    const hasDate   = Object.keys(createdAt).length > 0
    const saleWhere = {
      tenantId: req.tenantId,
      status:   'completada',
      ...(hasDate && { createdAt }),
    }

    // FIX: sale no tiene baseImponible ni paymentMethod — los pagos están en SalePayment[]
    const [sales, returns, purchases] = await Promise.all([
      prisma.sale.findMany({
        where:   saleWhere,
        select:  { total: true, igv: true, createdAt: true },
        include: { payments: { select: { method: true, amount: true } } },
      }),
      prisma.return.findMany({
        where:  { tenantId: req.tenantId, status: { not: 'anulada' }, ...(hasDate && { createdAt }) },
        select: { totalRefund: true },
      }),
      prisma.purchase.findMany({
        where:  { tenantId: req.tenantId, ...(hasDate && { createdAt }) },
        select: { total: true },
      }),
    ])

    const totalVentas      = sales.reduce((s, v) => s + v.total, 0)
    const totalIgv         = sales.reduce((s, v) => s + (v.igv || 0), 0)
    const totalBase        = sales.reduce((s, v) => s + (v.total - (v.igv || 0)), 0)
    const totalDevoluciones = returns.reduce((s, r) => s + r.totalRefund, 0)
    const totalCompras     = purchases.reduce((s, p) => s + p.total, 0)

    // Agrupar pagos por método desde SalePayment[]
    const byPayment = {}
    for (const sale of sales) {
      for (const pmt of sale.payments) {
        byPayment[pmt.method] = (byPayment[pmt.method] || 0) + pmt.amount
      }
    }
    // Redondear valores del mapa de pagos
    for (const k of Object.keys(byPayment)) {
      byPayment[k] = parseFloat(byPayment[k].toFixed(2))
    }

    return reply.send({
      data: {
        ventas: {
          count: sales.length,
          total: parseFloat(totalVentas.toFixed(2)),
          igv:   parseFloat(totalIgv.toFixed(2)),
          base:  parseFloat(totalBase.toFixed(2)),
        },
        devoluciones: {
          count: returns.length,
          total: parseFloat(totalDevoluciones.toFixed(2)),
        },
        compras: {
          count: purchases.length,
          total: parseFloat(totalCompras.toFixed(2)),
        },
        utilidadBruta: parseFloat((totalVentas - totalCompras - totalDevoluciones).toFixed(2)),
        byPayment,
      },
    })
  })

  // GET /api/reports/products?from=&to=  — top productos vendidos
  fastify.get('/reports/products', { preHandler: PRE }, async (req, reply) => {
    const { from, to, limit = '20' } = req.query
    const createdAt = dateRange(from, to)
    const hasDate   = Object.keys(createdAt).length > 0
    const saleWhere = {
      tenantId: req.tenantId,
      status:   'completada',
      ...(hasDate && { createdAt }),
    }

    // FIX: SaleItem no tiene subtotal ni categoryId — calcular subtotal desde quantity*unitPrice
    // y obtener categoryId desde el producto relacionado
    const items = await prisma.saleItem.findMany({
      where:   { sale: saleWhere },
      select: {
        productId:   true,
        productName: true,
        quantity:    true,
        unitPrice:   true,
        netTotal:    true,
        product:     { select: { categoryId: true } },
      },
    })

    const byProduct = {}
    for (const i of items) {
      if (!byProduct[i.productId]) {
        byProduct[i.productId] = {
          productId:  i.productId,
          name:       i.productName,
          categoryId: i.product?.categoryId || '',
          qty:        0,
          revenue:    0,
          count:      0,
        }
      }
      byProduct[i.productId].qty     += i.quantity
      // Usar netTotal si existe, si no calcular desde quantity * unitPrice
      byProduct[i.productId].revenue += i.netTotal != null ? i.netTotal : (i.quantity * i.unitPrice)
      byProduct[i.productId].count   += 1
    }

    const sorted = Object.values(byProduct)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, parseInt(limit) || 20)
      .map(p => ({ ...p, revenue: parseFloat(p.revenue.toFixed(2)) }))

    return reply.send({ data: sorted, meta: { total: sorted.length } })
  })

  // GET /api/reports/categories?from=&to=  — ventas por categoría
  fastify.get('/reports/categories', { preHandler: PRE }, async (req, reply) => {
    const { from, to } = req.query
    const createdAt = dateRange(from, to)
    const hasDate   = Object.keys(createdAt).length > 0
    const saleWhere = {
      tenantId: req.tenantId,
      status:   'completada',
      ...(hasDate && { createdAt }),
    }

    // FIX: obtener categoryId desde producto relacionado (no desde SaleItem)
    const items = await prisma.saleItem.findMany({
      where:  { sale: saleWhere },
      select: {
        quantity:  true,
        unitPrice: true,
        netTotal:  true,
        product:   { select: { categoryId: true } },
      },
    })

    const byCat = {}
    for (const i of items) {
      const cat = i.product?.categoryId || 'sin-categoria'
      if (!byCat[cat]) byCat[cat] = { category: cat, qty: 0, revenue: 0, count: 0 }
      byCat[cat].qty     += i.quantity
      byCat[cat].revenue += i.netTotal != null ? i.netTotal : (i.quantity * i.unitPrice)
      byCat[cat].count   += 1
    }

    const result = Object.values(byCat)
      .sort((a, b) => b.revenue - a.revenue)
      .map(c => ({ ...c, revenue: parseFloat(c.revenue.toFixed(2)) }))

    return reply.send({ data: result })
  })

  // GET /api/reports/daily?from=&to=  — ventas agrupadas por día
  fastify.get('/reports/daily', { preHandler: PRE }, async (req, reply) => {
    const { from, to } = req.query
    const createdAt = dateRange(from, to)
    const hasDate   = Object.keys(createdAt).length > 0
    const where = {
      tenantId: req.tenantId,
      status:   'completada',
      ...(hasDate && { createdAt }),
    }

    const sales = await prisma.sale.findMany({ where, select: { total: true, createdAt: true } })

    const byDay = {}
    for (const s of sales) {
      const day = s.createdAt.toISOString().split('T')[0]
      if (!byDay[day]) byDay[day] = { date: day, count: 0, total: 0 }
      byDay[day].count += 1
      byDay[day].total += s.total
    }

    const sorted = Object.values(byDay)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, total: parseFloat(d.total.toFixed(2)) }))

    return reply.send({ data: sorted })
  })

  // GET /api/reports/merma?from=&to=  — resumen de mermas
  fastify.get('/reports/merma', { preHandler: PRE }, async (req, reply) => {
    const { from, to } = req.query
    const createdAt = dateRange(from, to)
    const hasDate   = Object.keys(createdAt).length > 0
    const where = {
      tenantId: req.tenantId,
      ...(hasDate && { createdAt }),
    }

    const records = await prisma.mermaRecord.findMany({ where })

    const byReason = {}
    for (const r of records) {
      if (!byReason[r.reason]) byReason[r.reason] = { reason: r.reason, count: 0, units: 0, cost: 0 }
      byReason[r.reason].count += 1
      byReason[r.reason].units += r.quantity
      byReason[r.reason].cost  += r.quantity * r.costUnit
    }

    const result = Object.values(byReason)
      .map(r => ({ ...r, cost: parseFloat(r.cost.toFixed(2)) }))

    return reply.send({ data: result, meta: { total: records.length } })
  })

  // GET /api/reports/inventory  — valorización de inventario
  fastify.get('/reports/inventory', { preHandler: PRE }, async (req, reply) => {
    const products = await prisma.product.findMany({
      where:   { tenantId: req.tenantId, isActive: true },
      select:  { id: true, name: true, sku: true, categoryId: true, stock: true, priceBuy: true, priceSell: true, unit: true },
      orderBy: { name: 'asc' },
    })

    const items = products.map(p => ({
      ...p,
      costTotal:  parseFloat((p.stock * p.priceBuy).toFixed(2)),
      sellTotal:  parseFloat((p.stock * p.priceSell).toFixed(2)),
    }))

    const totalCost = parseFloat(items.reduce((s, i) => s + i.costTotal, 0).toFixed(2))
    const totalSell = parseFloat(items.reduce((s, i) => s + i.sellTotal, 0).toFixed(2))

    return reply.send({ data: items, meta: { total: items.length, totalCost, totalSell } })
  })
}
