import 'dotenv/config'
import Fastify   from 'fastify'
import cors      from '@fastify/cors'
import jwt       from '@fastify/jwt'
import { config } from './config.js'

// ── Rutas Fase 1 ──────────────────────────────────────────────────────────────
import authRoutes    from './routes/auth.routes.js'
import tenantsRoutes from './routes/tenants.routes.js'

// ── Rutas Fase 2 ──────────────────────────────────────────────────────────────
import categoriesRoutes from './routes/categories.routes.js'
import brandsRoutes     from './routes/brands.routes.js'
import productsRoutes   from './routes/products.routes.js'
import clientsRoutes    from './routes/clients.routes.js'
import salesRoutes      from './routes/sales.routes.js'
import cashRoutes       from './routes/cash.routes.js'

// ── Rutas Fase 3 ──────────────────────────────────────────────────────────────
import suppliersRoutes from './routes/suppliers.routes.js'
import purchasesRoutes from './routes/purchases.routes.js'
import returnsRoutes   from './routes/returns.routes.js'

// ── Rutas Fase 4 ──────────────────────────────────────────────────────────────
import campaignsRoutes from './routes/campaigns.routes.js'
import ticketsRoutes   from './routes/tickets.routes.js'

// ── Rutas Fase 5 ──────────────────────────────────────────────────────────────
import usersRoutes          from './routes/users.routes.js'
import stockMovementsRoutes from './routes/stockMovements.routes.js'

// ── Rutas Fase 6 ──────────────────────────────────────────────────────────────
import mermaRoutes      from './routes/merma.routes.js'
import auditRoutes      from './routes/audit.routes.js'
import quotationsRoutes from './routes/quotations.routes.js'
import reportsRoutes    from './routes/reports.routes.js'
import dashboardRoutes  from './routes/dashboard.routes.js'
import alertsRoutes     from './routes/alerts.routes.js'

// ── Pendientes resueltos ──────────────────────────────────────────────────────
import stockReserveRoutes  from './routes/stockReserve.routes.js'
import variantsRoutes      from './routes/variants.routes.js'
import syncRoutes          from './routes/sync.routes.js'
import serialsRoutes       from './routes/serials.routes.js'       // ← NUEVO: números de serie
import locationsRoutes     from './routes/locations.routes.js'     // ← NUEVO: almacén vs góndola
import notificationsRoutes from './routes/notifications.routes.js' // ← NUEVO: alertas por email

// Falla rápido si se inicia en producción con credenciales por defecto
if (config.nodeEnv === 'production') {
  const INSECURE = ['dev-secret-change-in-production', 'superadmin123']
  if (INSECURE.includes(config.jwtSecret)) {
    console.error('FATAL: JWT_SECRET usa el valor por defecto. Configura la variable de entorno antes de iniciar en producción.')
    process.exit(1)
  }
  if (INSECURE.includes(config.superadminPass)) {
    console.error('FATAL: SUPERADMIN_PASS usa el valor por defecto. Configura la variable de entorno antes de iniciar en producción.')
    process.exit(1)
  }
}

const fastify = Fastify({ logger: { level: config.nodeEnv === 'development' ? 'info' : 'warn' } })

await fastify.register(cors, {
  origin:         [config.frontendUrl, 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
})

await fastify.register(jwt, {
  secret: config.jwtSecret,
  sign:   { expiresIn: config.jwtExpiresIn },
})

fastify.get('/health', async () => ({
  status:    'ok',
  service:   'minimarket-api',
  version:   '2.2.0',
  timestamp: new Date().toISOString(),
}))

const API = { prefix: '/api' }

// Fase 1
await fastify.register(authRoutes,    API)
await fastify.register(tenantsRoutes, API)

// Fase 2
await fastify.register(categoriesRoutes, API)
await fastify.register(brandsRoutes,     API)
await fastify.register(productsRoutes,   API)
await fastify.register(variantsRoutes,   API)
await fastify.register(serialsRoutes,    API)  // /products/:id/serials | /products/serial/:sn
await fastify.register(clientsRoutes,    API)
await fastify.register(salesRoutes,      API)
await fastify.register(cashRoutes,       API)

// Fase 3
await fastify.register(suppliersRoutes, API)
await fastify.register(purchasesRoutes, API)
await fastify.register(returnsRoutes,   API)

// Fase 4
await fastify.register(campaignsRoutes, API)
await fastify.register(ticketsRoutes,   API)

// Fase 5
await fastify.register(usersRoutes,          API)
await fastify.register(stockMovementsRoutes, API)

// Fase 6
await fastify.register(mermaRoutes,      API)
await fastify.register(auditRoutes,      API)
await fastify.register(quotationsRoutes, API)
await fastify.register(reportsRoutes,    API)
await fastify.register(dashboardRoutes,  API)
await fastify.register(alertsRoutes,     API)

// Pendientes resueltos
await fastify.register(stockReserveRoutes,  API)  // /stock-reserve
await fastify.register(syncRoutes,          API)  // /sync/pending-sales
await fastify.register(locationsRoutes,     API)  // /locations | /locations/transfer
await fastify.register(notificationsRoutes, API)  // /notifications/email/*

fastify.setNotFoundHandler(async (req, reply) => {
  return reply.code(501).send({
    error:   'Not implemented',
    message: `${req.method} ${req.url} aún no está implementado`,
  })
})

fastify.setErrorHandler(async (err, req, reply) => {
  fastify.log.error(err)
  return reply.code(err.statusCode || 500).send({
    error: err.message || 'Error interno del servidor',
    ...(config.nodeEnv === 'development' && { stack: err.stack }),
  })
})

try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`\n  ┌──────────────────────────────────────────────────────┐`)
  console.log(`  │  minimarket-api v2.2.0                               │`)
  console.log(`  │  http://localhost:${config.port}                           │`)
  console.log(`  │                                                      │`)
  console.log(`  │  ✓ F1  Auth · Tenants · SuperAdmin                  │`)
  console.log(`  │  ✓ F2  Productos · Variantes · Seriales · Clientes  │`)
  console.log(`  │  ✓ F2  Ventas · Caja                                │`)
  console.log(`  │  ✓ F3  Proveedores · Compras · Devoluciones         │`)
  console.log(`  │  ✓ F4  Campañas · Tickets de descuento              │`)
  console.log(`  │  ✓ F5  Usuarios · Stock-movements · Contadores      │`)
  console.log(`  │  ✓ F6  Merma · Auditoría · Cotizaciones             │`)
  console.log(`  │  ✓ F6  Reportes · Dashboard · Alertas               │`)
  console.log(`  │  ✓ FX  Reserva multi-caja · Sync offline            │`)
  console.log(`  │  ✓ FX  Ubicaciones · Seriales · Email alerts        │`)
  console.log(`  │  ○ F7  SUNAT via factu-api (pendiente)              │`)
  console.log(`  └──────────────────────────────────────────────────────┘\n`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
