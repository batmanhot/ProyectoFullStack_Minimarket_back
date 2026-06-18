import prisma    from '../db.js'
import { requireAuth, requireAdmin } from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError } from '../utils/response.js'

const PRE_ADMIN = [requireAuth, resolveTenant, requireAdmin]

export default async function auditRoutes(fastify) {

  // GET /api/audit — lista de logs de auditoría (solo admins/gerentes)
  fastify.get('/audit', { preHandler: PRE_ADMIN }, async (req, reply) => {
    const { search, action, entity, userId, from, to, limit = '100', page = '1' } = req.query
    const take = Math.min(parseInt(limit) || 100, 500)
    const skip = (parseInt(page) - 1) * take

    const where = {
      tenantId: req.tenantId,
      ...(action && { action }),
      ...(entity && { entity }),
      ...(userId && { userId }),
      ...((from || to) && {
        createdAt: {
          ...(from && { gte: new Date(from) }),
          ...(to   && { lte: new Date(to)   }),
        },
      }),
      ...(search && {
        OR: [
          { userName: { contains: search, mode: 'insensitive' } },
          { detail:   { contains: search, mode: 'insensitive' } },
          { entityId: { contains: search, mode: 'insensitive' } },
        ],
      }),
    }

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    ])

    return sendOk(reply, logs, { total, page: parseInt(page), limit: take })
  })

  // POST /api/audit — persiste una entrada de auditoría desde el frontend
  fastify.post('/audit', { preHandler: [requireAuth, resolveTenant] }, async (req, reply) => {
    const { action, entity, entityId = '', detail = '' } = req.body || {}
    if (!action || !entity) return sendError(reply, 'action y entity son requeridos')

    const user = req.user
    const log = await prisma.auditLog.create({
      data: {
        tenantId: req.tenantId,
        userId:   user?.id       || 'system',
        userName: user?.fullName || user?.username || 'sistema',
        action,
        entity,
        entityId: String(entityId),
        detail,
        ip: req.ip || '',
      },
    })
    return sendOk(reply, log, null, 201)
  })
}
