import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, send404 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

export default async function stockMovementsRoutes(fastify) {

  // GET /api/stock-movements
  fastify.get('/stock-movements', { preHandler: PRE }, async (req, reply) => {
    const {
      productId, type, dateFrom, dateTo,
      invoiceNumber, search,
      page = '1', limit = '100',
    } = req.query

    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      tenantId: req.tenantId,
      ...(productId      && { productId }),
      ...(type           && { type }),
      ...(invoiceNumber  && { invoiceNumber: { contains: invoiceNumber } }),
      ...(search         && {
        OR: [
          { productName:   { contains: search, mode: 'insensitive' } },
          { reason:        { contains: search, mode: 'insensitive' } },
          { invoiceNumber: { contains: search } },
        ],
      }),
      ...(dateFrom || dateTo ? {
        createdAt: {
          ...(dateFrom && { gte: new Date(dateFrom) }),
          ...(dateTo   && { lte: new Date(dateTo)   }),
        },
      } : {}),
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        skip,
        take:     parseInt(limit),
        orderBy:  { createdAt: 'desc' },
        include:  { product: { select: { name: true, unit: true, stockControl: true } } },
      }),
      prisma.stockMovement.count({ where }),
    ])

    return sendOk(reply, movements, { total, page: parseInt(page), limit: parseInt(limit) })
  })

  // GET /api/stock-movements/product/:productId  — kardex completo de un producto
  fastify.get('/stock-movements/product/:productId', { preHandler: PRE }, async (req, reply) => {
    const { dateFrom, dateTo, page = '1', limit = '200' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const product = await prisma.product.findFirst({
      where:   { id: req.params.productId, tenantId: req.tenantId },
      include: { batches: true, variants: true },
    })
    if (!product) return send404(reply, 'Producto')

    const where = {
      tenantId:  req.tenantId,
      productId: req.params.productId,
      ...(dateFrom || dateTo ? {
        createdAt: {
          ...(dateFrom && { gte: new Date(dateFrom) }),
          ...(dateTo   && { lte: new Date(dateTo)   }),
        },
      } : {}),
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({ where, skip, take: parseInt(limit), orderBy: { createdAt: 'asc' } }),
      prisma.stockMovement.count({ where }),
    ])

    return reply.send({
      data:    movements,
      product: { id: product.id, name: product.name, unit: product.unit, stock: product.stock, stockControl: product.stockControl, batches: product.batches, variants: product.variants },
      meta:    { total, page: parseInt(page), limit: parseInt(limit) },
    })
  })
}
