/**
 * notifications.routes.js
 * Servicio de notificaciones por email para alertas críticas del sistema.
 *
 * POST /api/notifications/email/test     → enviar email de prueba
 * POST /api/notifications/email/alert    → enviar alerta puntual por email
 * POST /api/notifications/email/summary  → enviar resumen diario de alertas
 *
 * Usa Nodemailer con configuración SMTP por tenant (desde businessConfig).
 * Si no hay SMTP configurado, usa el SMTP global del servidor.
 *
 * DEPENDENCIA: npm install nodemailer
 */
import { z }            from 'zod'
import nodemailer       from 'nodemailer'
import prisma           from '../db.js'
import { requireAuth }  from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { config }       from '../config.js'
import { sendOk, sendError } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

// ── Crear transporter con config del servidor ─────────────────────────────────
function createTransporter() {
  if (!config.smtpHost) return null
  return nodemailer.createTransport({
    host:   config.smtpHost,
    port:   parseInt(config.smtpPort || '587'),
    secure: config.smtpPort === '465',
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  })
}

// ── Template HTML para alertas ────────────────────────────────────────────────
function buildAlertEmailHtml({ businessName, alerts, generatedAt }) {
  const bySeverity = {
    critical: alerts.filter(a => a.severity === 'critical'),
    urgent:   alerts.filter(a => a.severity === 'urgent'),
    warning:  alerts.filter(a => a.severity === 'warning'),
  }

  const severityColor = { critical: '#ef4444', urgent: '#f97316', warning: '#f59e0b' }
  const severityLabel = { critical: 'CRÍTICO', urgent: 'URGENTE', warning: 'ADVERTENCIA' }

  const rows = Object.entries(bySeverity)
    .filter(([, list]) => list.length > 0)
    .map(([sev, list]) => `
      <tr>
        <td colspan="2" style="padding:8px 16px;background:#f8fafc;font-size:11px;font-weight:700;color:${severityColor[sev]};letter-spacing:.05em;text-transform:uppercase;">
          ${severityLabel[sev]} (${list.length})
        </td>
      </tr>
      ${list.map(a => `
        <tr>
          <td style="padding:6px 16px 6px 24px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${a.title}</td>
          <td style="padding:6px 16px;font-size:12px;color:#6b7280;border-bottom:1px solid #f3f4f6;">${a.message}</td>
        </tr>`).join('')}
    `).join('')

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

        <!-- Header -->
        <div style="background:#1e40af;padding:24px 32px">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">Alertas del sistema</h1>
          <p style="margin:4px 0 0;color:#93c5fd;font-size:13px">${businessName} · ${generatedAt}</p>
        </div>

        <!-- Resumen -->
        <div style="padding:16px 32px;background:#eff6ff;border-bottom:1px solid #dbeafe;display:flex;gap:24px">
          ${Object.entries(bySeverity).map(([sev, list]) => `
            <div style="text-align:center">
              <div style="font-size:24px;font-weight:900;color:${severityColor[sev]}">${list.length}</div>
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase">${severityLabel[sev]}</div>
            </div>`).join('')}
          <div style="text-align:center">
            <div style="font-size:24px;font-weight:900;color:#374151">${alerts.length}</div>
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase">Total</div>
          </div>
        </div>

        <!-- Tabla de alertas -->
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase">Alerta</th>
              <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase">Detalle</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <!-- Footer -->
        <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #f3f4f6">
          <p style="margin:0;font-size:11px;color:#9ca3af">
            Generado automáticamente por Minimarket POS SaaS · ${new Date().getFullYear()}
          </p>
        </div>
      </div>
    </body>
    </html>`
}

export default async function notificationsRoutes(fastify) {

  // POST /api/notifications/email/test — verificar configuración SMTP
  fastify.post('/notifications/email/test', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      toEmail: z.string().email(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Email de destino inválido')

    const transporter = createTransporter()
    if (!transporter) {
      return sendError(reply, 'SMTP no configurado en el servidor. Configura SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASS en el .env', 503)
    }

    const tenant = await prisma.tenant.findUnique({
      where:  { id: req.tenantId },
      select: { businessName: true },
    })

    try {
      await transporter.sendMail({
        from:    `"Minimarket POS" <${config.smtpUser}>`,
        to:      parsed.data.toEmail,
        subject: `✅ Prueba de email — ${tenant?.businessName || 'Minimarket POS'}`,
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:32px auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
            <h2 style="color:#1e40af;margin:0 0 12px">✅ Configuración correcta</h2>
            <p style="color:#374151;margin:0">El servidor de email está funcionando correctamente para <strong>${tenant?.businessName}</strong>.</p>
            <p style="color:#9ca3af;font-size:12px;margin:16px 0 0">${new Date().toLocaleString('es-PE')}</p>
          </div>`,
      })
      return sendOk(reply, { sent: true, to: parsed.data.toEmail })
    } catch (err) {
      return sendError(reply, `Error SMTP: ${err.message}`, 502)
    }
  })

  // POST /api/notifications/email/alert — enviar alerta puntual
  fastify.post('/notifications/email/alert', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      toEmail: z.string().email(),
      alert: z.object({
        severity: z.string(),
        title:    z.string(),
        message:  z.string(),
      }),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const transporter = createTransporter()
    if (!transporter) return sendError(reply, 'SMTP no configurado', 503)

    const tenant = await prisma.tenant.findUnique({
      where:  { id: req.tenantId },
      select: { businessName: true },
    })

    const severityLabel = { critical: '🔴 CRÍTICO', urgent: '🟠 URGENTE', warning: '🟡 ADVERTENCIA' }
    const label = severityLabel[parsed.data.alert.severity] || '⚠️ ALERTA'

    try {
      await transporter.sendMail({
        from:    `"Minimarket POS" <${config.smtpUser}>`,
        to:      parsed.data.toEmail,
        subject: `${label} — ${parsed.data.alert.title} | ${tenant?.businessName}`,
        html:    buildAlertEmailHtml({
          businessName: tenant?.businessName || '',
          alerts:       [parsed.data.alert],
          generatedAt:  new Date().toLocaleString('es-PE'),
        }),
      })
      return sendOk(reply, { sent: true, to: parsed.data.toEmail })
    } catch (err) {
      return sendError(reply, `Error al enviar email: ${err.message}`, 502)
    }
  })

  // POST /api/notifications/email/summary — resumen diario de todas las alertas activas
  fastify.post('/notifications/email/summary', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      toEmail: z.string().email(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Email de destino inválido')

    const transporter = createTransporter()
    if (!transporter) return sendError(reply, 'SMTP no configurado', 503)

    const tid = req.tenantId
    const now  = new Date()
    const in30 = new Date(Date.now() + 30 * 86400_000)
    const in7  = new Date(Date.now() +  7 * 86400_000)

    // Recolectar alertas igual que alerts.routes.js
    const [products, batches, clients, tenant] = await Promise.all([
      prisma.product.findMany({
        where:  { tenantId: tid, isActive: true },
        select: { id: true, name: true, stock: true, stockMin: true, unit: true },
      }),
      prisma.productBatch.findMany({
        where:   { product: { tenantId: tid, isActive: true }, status: 'activo', expiryDate: { lte: in30 } },
        include: { product: { select: { name: true } } },
      }),
      prisma.client.findMany({
        where:  { tenantId: tid, isActive: true, currentDebt: { gt: 0 } },
        select: { name: true, currentDebt: true, creditLimit: true },
      }),
      prisma.tenant.findUnique({ where: { id: tid }, select: { businessName: true } }),
    ])

    const alerts = []

    for (const p of products) {
      if (p.stock <= 0) {
        alerts.push({ type: 'stock', severity: 'critical', title: 'Sin stock', message: `${p.name} (stock: 0)` })
      } else if (p.stock <= p.stockMin) {
        alerts.push({ type: 'stock', severity: 'warning', title: 'Stock bajo', message: `${p.name} (${p.stock}/${p.stockMin})` })
      }
    }

    for (const b of batches) {
      const exp = new Date(b.expiryDate)
      if (exp <= now) {
        alerts.push({ type: 'lote', severity: 'critical', title: 'Lote vencido', message: `${b.product.name} — Lote ${b.number}` })
      } else if (exp <= in7) {
        alerts.push({ type: 'lote', severity: 'urgent', title: 'Vence en 7 días', message: `${b.product.name} — Lote ${b.number}` })
      } else {
        alerts.push({ type: 'lote', severity: 'warning', title: 'Vence en 30 días', message: `${b.product.name} — Lote ${b.number}` })
      }
    }

    for (const c of clients) {
      if (c.creditLimit > 0 && c.currentDebt > c.creditLimit) {
        alerts.push({ type: 'deuda', severity: 'warning', title: 'Crédito excedido', message: `${c.name} debe S/${c.currentDebt.toFixed(2)}` })
      }
    }

    if (alerts.length === 0) {
      return sendOk(reply, { sent: false, reason: 'Sin alertas activas' })
    }

    try {
      await transporter.sendMail({
        from:    `"Minimarket POS" <${config.smtpUser}>`,
        to:      parsed.data.toEmail,
        subject: `📊 Resumen diario — ${alerts.length} alerta(s) | ${tenant?.businessName}`,
        html:    buildAlertEmailHtml({
          businessName: tenant?.businessName || '',
          alerts,
          generatedAt:  new Date().toLocaleString('es-PE'),
        }),
      })
      return sendOk(reply, { sent: true, to: parsed.data.toEmail, alertCount: alerts.length })
    } catch (err) {
      return sendError(reply, `Error al enviar resumen: ${err.message}`, 502)
    }
  })
}
