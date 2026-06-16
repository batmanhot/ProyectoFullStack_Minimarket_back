// Middleware de autenticación JWT.
// Verifica el token Bearer en cada ruta protegida y adjunta
// `request.user` con { id, tenantId, tenantSlug, role, fullName }.
// Rutas públicas (login, health, tenants/:slug) deben registrarse SIN este hook.

export async function requireAuth(request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Token inválido o expirado' })
  }
}

// Variante que además exige rol admin o gerente
export async function requireAdmin(request, reply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  const { role } = request.user
  if (role !== 'admin' && role !== 'gerente') {
    return reply.code(403).send({ error: 'No tienes permiso para realizar esta acción' })
  }
}

// Variante exclusiva para superadmin (sin tenantId en el token)
export async function requireSuperAdmin(request, reply) {
  await requireAuth(request, reply)
  if (reply.sent) return
  if (request.user.role !== 'superadmin') {
    return reply.code(403).send({ error: 'Acceso restringido a superadmin' })
  }
}
