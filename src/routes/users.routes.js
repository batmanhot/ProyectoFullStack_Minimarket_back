import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth, requireAdmin } from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE       = [requireAuth, resolveTenant]
const PRE_ADMIN = [requireAuth, resolveTenant, requireAdmin]
const PRIVILEGED_ROLES = new Set(['admin', 'gerente'])
const passwordSchema = z.string().min(12).max(128)

// Un gerente administra al personal operativo, pero no puede escalar ni
// bloquear cuentas administrativas.
const managerCanManage = (actorRole, targetRole, nextRole) =>
  actorRole !== 'gerente' || (!PRIVILEGED_ROLES.has(targetRole) && !PRIVILEGED_ROLES.has(nextRole))

const userCreateSchema = z.object({
  fullName: z.string().min(2),
  username: z.string().min(3),
  password: passwordSchema,
  role:     z.enum(['admin', 'gerente', 'supervisor', 'cajero']).default('cajero'),
  email:    z.string().email().optional().or(z.literal('')).default(''),
})

const userUpdateSchema = z.object({
  fullName: z.string().min(2).optional(),
  role:     z.enum(['admin', 'gerente', 'supervisor', 'cajero']).optional(),
  email:    z.string().email().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
})

export default async function usersRoutes(fastify) {

  // GET /api/users  — lista todos los usuarios del tenant
  fastify.get('/users', { preHandler: PRE }, async (req, reply) => {
    const { search, role, isActive } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(role     && { role }),
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
      ...(search   && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { username: { contains: search, mode: 'insensitive' } },
          { email:    { contains: search, mode: 'insensitive' } },
        ],
      }),
    }
    const users = await prisma.user.findMany({
      where,
      orderBy: { fullName: 'asc' },
      select: {
        id: true, fullName: true, username: true, role: true,
        email: true, isActive: true, createdAt: true, updatedAt: true,
      },
    })
    return sendOk(reply, users, { total: users.length })
  })

  // GET /api/users/:id
  fastify.get('/users/:id', { preHandler: PRE }, async (req, reply) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: {
        id: true, fullName: true, username: true, role: true,
        email: true, isActive: true, createdAt: true, updatedAt: true,
      },
    })
    if (!user) return send404(reply, 'Usuario')
    return sendOk(reply, user)
  })

  // POST /api/users  — solo admin/gerente puede crear usuarios
  fastify.post('/users', { preHandler: PRE_ADMIN }, async (req, reply) => {
    const parsed = userCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    const d = parsed.data

    if (!managerCanManage(req.user.role, null, d.role)) {
      return sendError(reply, 'Un gerente no puede crear cuentas administrativas', 403)
    }

    const existing = await prisma.user.findUnique({
      where: { tenantId_username: { tenantId: req.tenantId, username: d.username } },
    })
    if (existing) return send409(reply, `El usuario "${d.username}" ya existe en este negocio`)

    const { default: bcrypt } = await import('bcryptjs')
    const passwordHash = await bcrypt.hash(d.password, 10)

    const user = await prisma.user.create({
      data: {
        tenantId: req.tenantId,
        fullName: d.fullName,
        username: d.username,
        passwordHash,
        role:     d.role,
        email:    d.email,
      },
      select: {
        id: true, fullName: true, username: true, role: true,
        email: true, isActive: true, createdAt: true,
      },
    })
    return sendOk(reply, user, null, 201)
  })

  // PUT /api/users/:id  — actualizar datos del usuario (no contraseña)
  fastify.put('/users/:id', { preHandler: PRE_ADMIN }, async (req, reply) => {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Usuario')

    const parsed = userUpdateSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    if (!managerCanManage(req.user.role, existing.role, parsed.data.role ?? existing.role)) {
      return sendError(reply, 'Un gerente no puede modificar cuentas administrativas', 403)
    }

    // No permitir que el último admin se desactive
    if (parsed.data.isActive === false || (parsed.data.role && parsed.data.role !== 'admin')) {
      if (existing.role === 'admin') {
        const adminCount = await prisma.user.count({
          where: { tenantId: req.tenantId, role: 'admin', isActive: true, id: { not: existing.id } },
        })
        if (adminCount === 0) {
          return send409(reply, 'No se puede modificar el único administrador activo')
        }
      }
    }

    const securityChanged = parsed.data.isActive !== undefined || parsed.data.role !== undefined
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data:  {
        ...parsed.data,
        ...(securityChanged && { sessionVersion: { increment: 1 } }),
      },
      select: {
        id: true, fullName: true, username: true, role: true,
        email: true, isActive: true, updatedAt: true,
      },
    })
    return sendOk(reply, user)
  })

  // PATCH /api/users/:id/password  — cambiar contraseña
  fastify.patch('/users/:id/password', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      currentPassword: z.string().optional(),
      newPassword:     passwordSchema,
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'La nueva contraseña debe tener al menos 6 caracteres')

    const target = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!target) return send404(reply, 'Usuario')

    const isSelf  = req.user.id === target.id
    const isAdmin = ['admin', 'gerente'].includes(req.user.role)

    // Todo usuario que cambia su propia contraseña debe acreditar la actual.
    // Un admin/gerente solo puede omitirla al restablecer la de otra persona.
    if (isSelf) {
      if (!parsed.data.currentPassword) {
        return sendError(reply, 'Debes ingresar tu contraseña actual', 400)
      }
      const { default: bcrypt } = await import('bcryptjs')
      const valid = await bcrypt.compare(parsed.data.currentPassword, target.passwordHash)
      if (!valid) return sendError(reply, 'La contraseña actual es incorrecta', 401)
    } else if (!isSelf && !isAdmin) {
      return sendError(reply, 'No tienes permiso para cambiar la contraseña de otro usuario', 403)
    } else if (!managerCanManage(req.user.role, target.role, target.role)) {
      return sendError(reply, 'Un gerente no puede restablecer contraseñas administrativas', 403)
    }

    const { default: bcrypt } = await import('bcryptjs')
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10)
    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    })

    return sendOk(reply, { id: target.id, message: 'Contraseña actualizada' })
  })

  // DELETE /api/users/:id  — soft delete (isActive: false)
  fastify.delete('/users/:id', { preHandler: PRE_ADMIN }, async (req, reply) => {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Usuario')
    if (req.user.id === existing.id) return send409(reply, 'No puedes eliminar tu propia cuenta')
    if (!managerCanManage(req.user.role, existing.role, existing.role)) {
      return sendError(reply, 'Un gerente no puede desactivar cuentas administrativas', 403)
    }

    if (existing.role === 'admin') {
      const adminCount = await prisma.user.count({
        where: { tenantId: req.tenantId, role: 'admin', isActive: true, id: { not: existing.id } },
      })
      if (adminCount === 0) {
        return send409(reply, 'No se puede eliminar el único administrador activo')
      }
    }

    await prisma.user.update({
      where: { id: existing.id },
      data: { isActive: false, sessionVersion: { increment: 1 } },
    })
    return sendOk(reply, { id: existing.id, deleted: true })
  })

  // GET /api/admin/users  — SuperAdmin: ver usuarios de cualquier tenant
  fastify.get('/admin/users', { preHandler: [requireAuth] }, async (req, reply) => {
    if (req.user.role !== 'superadmin') return sendError(reply, 'Solo superadmin', 403)
    const { tenantId, search, page = '1', limit = '50' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const where = {
      ...(tenantId && { tenantId }),
      ...(search   && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { username: { contains: search, mode: 'insensitive' } },
        ],
      }),
    }
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, tenantId: true, fullName: true, username: true,
          role: true, email: true, isActive: true, createdAt: true,
          tenant: { select: { slug: true, businessName: true } },
        },
      }),
      prisma.user.count({ where }),
    ])
    return sendOk(reply, users, { total })
  })
}
