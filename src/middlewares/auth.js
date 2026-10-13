import prisma from '../db.js'
import { getSessionToken } from '../utils/session.js'

export async function requireAuth(request, reply) {
  try {
    const token = getSessionToken(request)
    if (!token) throw new Error('Missing session')
    request.user = await request.server.jwt.verify(token)
  } catch {
    return reply.code(401).send({ error: 'Token invalido o expirado' })
  }

  // Superadmin credentials are environment-backed. Tenant users are checked
  // on every request so disabled accounts, role changes and password resets
  // invalidate existing bearer tokens immediately.
  if (request.user.role === 'superadmin') return

  const user = await prisma.user.findUnique({
    where: { id: request.user.id },
    select: { tenantId: true, role: true, isActive: true, sessionVersion: true },
  })
  if (!user || !user.isActive || user.tenantId !== request.user.tenantId ||
      user.role !== request.user.role || user.sessionVersion !== request.user.sessionVersion) {
    return reply.code(401).send({ error: 'La sesion fue revocada. Inicia sesion nuevamente.' })
  }
}

export async function requireAdmin(request, reply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  const { role } = request.user
  if (role !== 'admin' && role !== 'gerente') {
    return reply.code(403).send({ error: 'No tienes permiso para realizar esta accion' })
  }
}

export async function requireSuperAdmin(request, reply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (request.user.role !== 'superadmin') {
    return reply.code(403).send({ error: 'Acceso restringido a superadmin' })
  }
}
