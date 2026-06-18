import prisma    from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

export default async function alertsRoutes(fastify) {

  // GET /api/alerts  — alertas calculadas en tiempo real desde los datos del tenant
  fastify.get('/alerts', { preHandler: PRE }, async (req, reply) => {
    const tid = req.tenantId

    const [products, batches, clients, cashSession] = await Promise.all([
      prisma.product.findMany({
        where:  { tenantId: tid, isActive: true },
        select: { id: true, name: true, stock: true, stockMin: true, unit: true },
      }),
      prisma.productBatch.findMany({
        where:   { product: { tenantId: tid, isActive: true }, status: 'activo' },
        include: { product: { select: { id: true, name: true } } },
      }),
      prisma.client.findMany({
        where:  { tenantId: tid, isActive: true, currentDebt: { gt: 0 } },
        select: { id: true, name: true, currentDebt: true, creditLimit: true },
      }),
      prisma.cashSession.findFirst({
        where:  { tenantId: tid, status: 'abierta' },
        select: { openedAt: true },
      }),
    ])

    const alerts = []
    const now   = new Date()
    const in30  = new Date(Date.now() + 30 * 86400_000)
    const in7   = new Date(Date.now() +  7 * 86400_000)

    // Stock bajo o agotado
    for (const p of products) {
      if (p.stock <= 0) {
        alerts.push({
          type: 'stock_agotado', severity: 'critical',
          entity: 'product', entityId: p.id,
          title: 'Producto sin stock',
          message: `${p.name} está agotado (stock: 0 ${p.unit})`,
        })
      } else if (p.stock <= p.stockMin) {
        alerts.push({
          type: 'stock_bajo', severity: 'warning',
          entity: 'product', entityId: p.id,
          title: 'Stock bajo',
          message: `${p.name} tiene stock bajo (${p.stock}/${p.stockMin} ${p.unit})`,
        })
      }
    }

    // Lotes por vencer
    // FIX: usar b.number (campo correcto del schema) en vez de b.batchNumber (inexistente)
    for (const b of batches) {
      if (!b.expiryDate) continue
      const exp = new Date(b.expiryDate)
      if (exp <= now) {
        alerts.push({
          type: 'lote_vencido', severity: 'critical',
          entity: 'batch', entityId: b.id,
          title: 'Lote vencido',
          message: `${b.product.name} — Lote ${b.number} venció el ${exp.toLocaleDateString('es-PE')}`,
        })
      } else if (exp <= in7) {
        alerts.push({
          type: 'lote_por_vencer', severity: 'urgent',
          entity: 'batch', entityId: b.id,
          title: 'Vence en menos de 7 días',
          message: `${b.product.name} — Lote ${b.number} vence el ${exp.toLocaleDateString('es-PE')}`,
        })
      } else if (exp <= in30) {
        alerts.push({
          type: 'lote_por_vencer', severity: 'warning',
          entity: 'batch', entityId: b.id,
          title: 'Vence en 30 días',
          message: `${b.product.name} — Lote ${b.number} vence el ${exp.toLocaleDateString('es-PE')}`,
        })
      }
    }

    // Clientes con deuda excedida
    for (const c of clients) {
      if (c.creditLimit > 0 && c.currentDebt > c.creditLimit) {
        alerts.push({
          type: 'deuda_excedida', severity: 'warning',
          entity: 'client', entityId: c.id,
          title: 'Límite de crédito excedido',
          message: `${c.name} debe S/${c.currentDebt.toFixed(2)} (límite S/${c.creditLimit.toFixed(2)})`,
        })
      }
    }

    // Caja abierta hace más de 24 horas
    if (cashSession) {
      const hoursOpen = (now - new Date(cashSession.openedAt)) / 3600_000
      if (hoursOpen > 24) {
        alerts.push({
          type: 'caja_olvidada', severity: 'warning',
          entity: 'cash', entityId: '',
          title: 'Caja abierta más de 24 horas',
          message: `La sesión de caja lleva ${Math.round(hoursOpen)} horas abierta`,
        })
      }
    }

    const bySeverity = { critical: 0, urgent: 0, warning: 0, info: 0 }
    for (const a of alerts) bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1

    return sendOk(reply, alerts, { total: alerts.length, bySeverity })
  })
}
