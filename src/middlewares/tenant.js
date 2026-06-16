// Middleware de resolución de tenant.
// Lee X-Tenant-Id o X-Tenant-Slug del header (el frontend los envía siempre)
// y adjunta `request.tenantId` para que las rutas filtren datos por tenant.
// Solo aplica a rutas protegidas — las rutas públicas no necesitan tenant.

import prisma from '../db.js'

export async function resolveTenant(request, reply) {
  // Superadmin no tiene tenant
  if (request.user?.role === 'superadmin') return

  const tenantId   = request.headers['x-tenant-id']
  const tenantSlug = request.headers['x-tenant-slug']

  if (!tenantId && !tenantSlug) {
    return reply.code(400).send({ error: 'Falta el identificador de tenant (X-Tenant-Id o X-Tenant-Slug)' })
  }

  try {
    const tenant = tenantId
      ? await prisma.tenant.findUnique({ where: { id: tenantId } })
      : await prisma.tenant.findUnique({ where: { slug: tenantSlug } })

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
