import bcrypt from 'bcryptjs'
import { z }   from 'zod'
import prisma   from '../db.js'
import { config } from '../config.js'
import { requireAuth } from '../middlewares/auth.js'

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
      return reply.code(400).send({ error: 'Datos de inicio de sesión inválidos' })
    }
    const { username, password, tenantSlug } = parsed.data

    // ── Superadmin (acceso global sin tenant) ──────────────────────────────
    // FIX: comparar directamente con la contraseña en texto plano desde config
    // ya que no tenemos un hash pre-almacenado para el superadmin.
    if (username === config.superadminUser) {
      const valid = password === config.superadminPass
      if (!valid) return reply.code(401).send({ error: 'Credenciales incorrectas' })

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
    if (!tenant) return reply.code(401).send({ error: `Negocio "${tenantSlug}" no encontrado` })
    if (!tenant.isActive) return reply.code(403).send({ error: 'Acceso suspendido. Contacta al administrador.' })
    if (new Date(tenant.accessExpiresAt) < new Date()) {
      return reply.code(403).send({ error: 'El período de acceso ha vencido. Renueva tu suscripción.' })
    }

    const user = await prisma.user.findUnique({
      where: { tenantId_username: { tenantId: tenant.id, username } },
    })
    if (!user) return reply.code(401).send({ error: 'Credenciales incorrectas' })
    if (!user.isActive) return reply.code(403).send({ error: 'Usuario desactivado' })

    const validPassword = await bcrypt.compare(password, user.passwordHash)
    if (!validPassword) return reply.code(401).send({ error: 'Credenciales incorrectas' })

    const token = fastify.jwt.sign({
      id:         user.id,
      role:       user.role,
      fullName:   user.fullName,
      tenantId:   tenant.id,
      tenantSlug: tenant.slug,
      plan:       tenant.plan,
    })

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
    return reply.send({ data: null })
  })
}
