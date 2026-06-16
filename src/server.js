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

// ── Rutas nuevas (pendientes resueltos) ───────────────────────────────────────
import stockReserveRoutes from './routes/stockReserve.routes.js'  // Reserva multi-caja
import variantsRoutes     from './routes/variants.routes.js'       // Variantes de producto
import syncRoutes         from './routes/sync.routes.js'           // Sincronización offline

const fastify = Fastify({ logger: { level: config.nodeEnv === 'development' ? 'info' : 'warn' } })

// ── CORS ──────────────────────────────────────────────────────────────────────
await fastify.register(cors, {
  origin:  [config.frontendUrl, 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
})

// ── JWT ───────────────────────────────────────────────────────────────────────
await fastify.register(jwt, {
  secret: config.jwtSecret,
  sign:   { expiresIn: config.jwtExpiresIn },
})

// ── Health ────────────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status:    'ok',
  service:   'minimarket-api',
  version:   '2.1.0',
  timestamp: new Date().toISOString(),
}))

// ── Registro de rutas ─────────────────────────────────────────────────────────
const API = { prefix: '/api' }

// Fase 1
await fastify.register(authRoutes,    API)   // POST /auth/login | /auth/logout
await fastify.register(tenantsRoutes, API)   // GET /tenants/:slug | /admin/tenants ...

// Fase 2
await fastify.register(categoriesRoutes, API)  // GET/POST/PUT/DELETE /categories
await fastify.register(brandsRoutes,     API)  // GET/POST/PUT/DELETE /brands
await fastify.register(productsRoutes,   API)  // GET/POST/PUT/DELETE /products
await fastify.register(variantsRoutes,   API)  // GET/POST/PUT/PATCH/DELETE /products/:id/variants
await fastify.register(clientsRoutes,  API)   // GET/POST/PUT/DELETE /clients
await fastify.register(salesRoutes,    API)   // GET/POST /sales | PATCH /sales/:id/cancel
await fastify.register(cashRoutes,     API)   // GET /cash | POST /cash/open | /cash/:id/close

// Fase 3
await fastify.register(suppliersRoutes, API)   // GET/POST/PUT/DELETE /suppliers
await fastify.register(purchasesRoutes, API)   // GET/POST /purchases | PATCH /purchases/:id/status
await fastify.register(returnsRoutes,   API)   // GET/POST /returns | PATCH /returns/:id/anular

// Fase 4
await fastify.register(campaignsRoutes, API)   // GET/POST/PUT/PATCH/DELETE /campaigns
await fastify.register(ticketsRoutes,   API)   // GET/POST/PUT/DELETE /tickets | validate | redeem

// Fase 5
await fastify.register(usersRoutes,          API)  // GET/POST/PUT/DELETE /users
await fastify.register(stockMovementsRoutes, API)  // GET /stock-movements

// Fase 6
await fastify.register(mermaRoutes,      API)  // GET/POST /merma | PATCH /merma/:id/status
await fastify.register(auditRoutes,      API)  // GET /audit | POST /audit
await fastify.register(quotationsRoutes, API)  // GET/POST/PUT/DELETE /quotations
await fastify.register(reportsRoutes,    API)  // GET /reports/summary|products|categories|daily|merma|inventory
await fastify.register(dashboardRoutes,  API)  // GET /dashboard
await fastify.register(alertsRoutes,     API)  // GET /alerts

// Pendientes resueltos
await fastify.register(stockReserveRoutes, API)  // POST/DELETE/GET /stock-reserve
await fastify.register(syncRoutes,         API)  // POST /sync/pending-sales

// ── Rutas no implementadas ────────────────────────────────────────────────────
fastify.setNotFoundHandler(async (req, reply) => {
  fastify.log.warn(`No implementado: ${req.method} ${req.url}`)
  return reply.code(501).send({
    error:   'Not implemented',
    message: `${req.method} ${req.url} aún no está implementado`,
  })
})

// ── Error handler global ──────────────────────────────────────────────────────
fastify.setErrorHandler(async (err, req, reply) => {
  fastify.log.error(err)
  const status = err.statusCode || 500
  return reply.code(status).send({
    error: err.message || 'Error interno del servidor',
    ...(config.nodeEnv === 'development' && { stack: err.stack }),
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`\n  ┌──────────────────────────────────────────────────┐`)
  console.log(`  │  minimarket-api v2.1                              │`)
  console.log(`  │  http://localhost:${config.port}                         │`)
  console.log(`  │                                                  │`)
  console.log(`  │  Fases activas:                                  │`)
  console.log(`  │  ✓ F1  Auth + Tenants + SuperAdmin               │`)
  console.log(`  │  ✓ F2  Productos · Variantes · Clientes          │`)
  console.log(`  │  ✓ F2  Ventas · Caja                             │`)
  console.log(`  │  ✓ F3  Proveedores · Compras · Devoluciones      │`)
  console.log(`  │  ✓ F4  Campañas · Tickets de descuento           │`)
  console.log(`  │  ✓ F5  Usuarios · Stock-movements · Contadores   │`)
  console.log(`  │  ✓ F6  Merma · Auditoría · Cotizaciones          │`)
  console.log(`  │  ✓ F6  Reportes · Dashboard · Alertas            │`)
  console.log(`  │  ✓ FX  Reserva multi-caja · Sync offline         │`)
  console.log(`  │  ○ F7  SUNAT via factu-api (pendiente)           │`)
  console.log(`  └──────────────────────────────────────────────────┘\n`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
