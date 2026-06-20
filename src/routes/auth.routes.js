import bcrypt from 'bcryptjs'
import { createHash, timingSafeEqual } from 'crypto'
import { z }   from 'zod'
import prisma   from '../db.js'
import { config } from '../config.js'
import { requireAuth } from '../middlewares/auth.js'
import { sendOk, sendError } from '../utils/response.js'

// Comparación de contraseña en tiempo constante — previene timing attacks.
// Se hashea con SHA-256 para igualar longitudes antes de timingSafeEqual.
const safeEqualStr = (a, b) => timingSafeEqual(
  createHash('sha256').update(a).digest(),
  createHash('sha256').update(b).digest()
)

const loginSchema = z.object({
  username:   z.string().min(1),
  password:   z.string().min(1),
  tenantSlug: z.string().min(1),
})

export default async function authRoutes(fastify) {

  // POST /api/auth/login
  fastify.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      return sendError(reply, 'Datos de inicio de sesión inválidos')
    }
    const { username, password, tenantSlug } = parsed.data

    // ── Superadmin (acceso global sin tenant) ──────────────────────────────
    if (username === config.superadminUser) {
      const valid = safeEqualStr(password, config.superadminPass)
      if (!valid) return sendError(reply, 'Credenciales incorrectas', 401)

      const token = fastify.jwt.sign({
        id:         'superadmin',
        role:       'superadmin',
        fullName:   'Super Administrador',
        tenantId:   null,
        tenantSlug: null,
        plan:       'enterprise',
      })
      return reply.send({
        token,
        user: {
          id:         'superadmin',
          fullName:   'Super Administrador',
          role:       'superadmin',
          tenantId:   null,
          tenantSlug: null,
          plan:       'enterprise',
        },
      })
    }

    // ── Usuario de tenant ──────────────────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
    if (!tenant) return sendError(reply, `Negocio "${tenantSlug}" no encontrado`, 401)
    if (!tenant.isActive) return sendError(reply, 'Acceso suspendido. Contacta al administrador.', 403)
    if (new Date(tenant.accessExpiresAt) < new Date()) {
      return sendError(reply, 'El período de acceso ha vencido. Renueva tu suscripción.', 403)
    }

    const user = await prisma.user.findUnique({
      where: { tenantId_username: { tenantId: tenant.id, username } },
    })
    if (!user) return sendError(reply, 'Credenciales incorrectas', 401)
    if (!user.isActive) return sendError(reply, 'Usuario desactivado', 403)

    const validPassword = await bcrypt.compare(password, user.passwordHash)
    if (!validPassword) return sendError(reply, 'Credenciales incorrectas', 401)

    const token = fastify.jwt.sign({
      id:         user.id,
      role:       user.role,
      fullName:   user.fullName,
      tenantId:   tenant.id,
      tenantSlug: tenant.slug,
      plan:       tenant.plan,
    })

    // Registrar evento de login para historial en SuperAdmin
    prisma.loginEvent.create({
      data: {
        tenantId: tenant.id,
        userId:   user.id,
        fullName: user.fullName,
        username: user.username,
        role:     user.role,
      },
    }).catch(() => {})   // fire-and-forget; no bloquea la respuesta

    return reply.send({
      token,
      user: {
        id:         user.id,
        fullName:   user.fullName,
        username:   user.username,
        role:       user.role,
        email:      user.email,
        tenantId:   tenant.id,
        tenantSlug: tenant.slug,
        plan:       tenant.plan,
      },
    })
  })

  // POST /api/auth/logout  (el frontend borra el token en localStorage)
  fastify.post('/auth/logout', { preHandler: [requireAuth] }, async (req, reply) => {
    return sendOk(reply, null)
  })
}
