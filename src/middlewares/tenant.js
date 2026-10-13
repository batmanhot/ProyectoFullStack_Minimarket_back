// Middleware de resolución de tenant.
// Lee X-Tenant-Id o X-Tenant-Slug del header (el frontend los envía siempre)
// y adjunta `request.tenantId` para que las rutas filtren datos por tenant.
// Solo aplica a rutas protegidas — las rutas públicas no necesitan tenant.

import prisma from '../db.js'

export async function resolveTenant(request, reply) {
  // Superadmin no tiene tenant
  if (request.user?.role === 'superadmin') return

  // Para usuarios normales, el tenant siempre es el que fue firmado en el JWT.
  // Nunca se debe confiar en headers que el navegador puede modificar.
  const tenantId   = request.user?.tenantId
  const tenantSlug = request.user?.tenantSlug

  if (!tenantId) {
    return reply.code(401).send({ error: 'El token no contiene un tenant válido' })
  }

  const headerTenantId   = request.headers['x-tenant-id']
  const headerTenantSlug = request.headers['x-tenant-slug']
  if ((headerTenantId && headerTenantId !== tenantId) || (headerTenantSlug && headerTenantSlug !== tenantSlug)) {
    return reply.code(403).send({ error: 'El tenant indicado no coincide con la sesión autenticada' })
  }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })

    if (!tenant) return reply.code(404).send({ error: 'Tenant no encontrado' })
    if (!tenant.isActive) return reply.code(403).send({ error: 'Tenant inactivo o con acceso suspendido' })

    // Verificar expiración de acceso
    if (new Date(tenant.accessExpiresAt) < new Date()) {
      return reply.code(403).send({ error: 'El período de acceso ha vencido. Renueva tu suscripción.' })
    }

    request.tenantId   = tenant.id
    request.tenantSlug = tenant.slug
    request.tenant     = tenant
  } catch (err) {
    request.log.error(err, 'Error al resolver tenant')
    return reply.code(500).send({ error: 'Error interno al resolver tenant' })
  }
}
