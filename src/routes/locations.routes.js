/**
 * locations.routes.js
 * Gestión de ubicaciones físicas (Almacén, Góndola, Mostrador, Bodega)
 * y transferencias de stock entre ellas.
 *
 * GET    /api/locations                          → lista de ubicaciones
 * POST   /api/locations                          → crear ubicación
 * PUT    /api/locations/:id                      → editar nombre/tipo
 * DELETE /api/locations/:id                      → desactivar (soft)
 *
 * GET    /api/locations/:id/stock                → stock de productos en esa ubicación
 * POST   /api/locations/transfer                 → transferir stock entre ubicaciones
 * GET    /api/locations/transfers                → historial de transferencias
 * DELETE /api/locations/transfers/:id            → anular transferencia (revierte stock)
 */
import { z }           from 'zod'
import prisma          from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

export default async function locationsRoutes(fastify) {

  // ── CRUD UBICACIONES ────────────────────────────────────────────────────────

  // GET /api/locations
  fastify.get('/locations', { preHandler: PRE }, async (req, reply) => {
    const locations = await prisma.location.findMany({
      where:   { tenantId: req.tenantId, isActive: true },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { productLocations: true } },
      },
    })
    return sendOk(reply, locations, { total: locations.length })
  })

  // POST /api/locations
  fastify.post('/locations', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      name:        z.string().min(1),
      description: z.string().default(''),
      type:        z.enum(['almacen','gondola','mostrador','bodega','otro']).default('almacen'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const exists = await prisma.location.findFirst({
      where: { tenantId: req.tenantId, name: parsed.data.name },
    })
    if (exists) return send409(reply, `Ya existe una ubicación llamada "${parsed.data.name}"`)

    const location = await prisma.location.create({
      data: { ...parsed.data, tenantId: req.tenantId },
    })
    return sendOk(reply, location, null, 201)
  })

  // PUT /api/locations/:id
  fastify.put('/locations/:id', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      name:        z.string().min(1).optional(),
      description: z.string().optional(),
      type:        z.enum(['almacen','gondola','mostrador','bodega','otro']).optional(),
      isActive:    z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const existing = await prisma.location.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Ubicación')

    if (parsed.data.name && parsed.data.name !== existing.name) {
      const dup = await prisma.location.findFirst({
        where: { tenantId: req.tenantId, name: parsed.data.name, id: { not: req.params.id } },
      })
      if (dup) return send409(reply, `El nombre "${parsed.data.name}" ya está en uso`)
    }

    const updated = await prisma.location.update({
      where: { id: req.params.id },
      data:  { ...parsed.data, updatedAt: new Date() },
    })
    return sendOk(reply, updated)
  })

  // DELETE /api/locations/:id  (soft delete)
  fastify.delete('/locations/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.location.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!existing) return send404(reply, 'Ubicación')

    const inUse = await prisma.productLocation.count({ where: { locationId: req.params.id } })
    if (inUse > 0) {
      return send409(reply, `Esta ubicación tiene ${inUse} producto(s) asignados. Reasígnalos antes de desactivarla.`)
    }

    await prisma.location.update({ where: { id: req.params.id }, data: { isActive: false } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })

  // ── STOCK POR UBICACIÓN ─────────────────────────────────────────────────────

  // GET /api/locations/:id/stock
  fastify.get('/locations/:id/stock', { preHandler: PRE }, async (req, reply) => {
    const location = await prisma.location.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!location) return send404(reply, 'Ubicación')

    const productLocations = await prisma.productLocation.findMany({
      where:   { locationId: req.params.id, tenantId: req.tenantId },
      include: {
        product: {
          select: { id: true, name: true, sku: true, barcode: true, unit: true, priceSell: true, stockMin: true },
        },
      },
      orderBy: { product: { name: 'asc' } },
    })

    return reply.send({
      data:     productLocations,
      location: { id: location.id, name: location.name, type: location.type },
      meta:     { total: productLocations.length },
    })
  })

  // ── TRANSFERENCIAS ──────────────────────────────────────────────────────────

  // POST /api/locations/transfer — transferir stock entre ubicaciones
  fastify.post('/locations/transfer', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      fromId:    z.string().uuid(),
      toId:      z.string().uuid(),
      productId: z.string().uuid(),
      quantity:  z.number().positive(),
      reason:    z.string().default('Transferencia interna'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })

    const { fromId, toId, productId, quantity, reason } = parsed.data

    if (fromId === toId) return sendError(reply, 'El origen y destino no pueden ser iguales')

    // Verificar que ambas ubicaciones existen y pertenecen al tenant
    const [from, to, product] = await Promise.all([
      prisma.location.findFirst({ where: { id: fromId, tenantId: req.tenantId, isActive: true } }),
      prisma.location.findFirst({ where: { id: toId,   tenantId: req.tenantId, isActive: true } }),
      prisma.product.findFirst({  where: { id: productId, tenantId: req.tenantId, isActive: true } }),
    ])
    if (!from)    return send404(reply, 'Ubicación origen')
    if (!to)      return send404(reply, 'Ubicación destino')
    if (!product) return send404(reply, 'Producto')

    // Verificar stock en origen
    const fromStock = await prisma.productLocation.findUnique({
      where: { productId_locationId: { productId, locationId: fromId } },
    })
    const stockEnOrigen = fromStock?.stock ?? 0
    if (stockEnOrigen < quantity) {
      return send409(reply, `Stock insuficiente en "${from.name}". Disponible: ${stockEnOrigen}, requerido: ${quantity}`)
    }

    const transfer = await prisma.$transaction(async (tx) => {
      // Descontar en origen
      await tx.productLocation.upsert({
        where:  { productId_locationId: { productId, locationId: fromId } },
        update: { stock: { decrement: quantity } },
        create: { productId, locationId: fromId, tenantId: req.tenantId, stock: 0 },
      })

      // Incrementar en destino
      await tx.productLocation.upsert({
        where:  { productId_locationId: { productId, locationId: toId } },
        update: { stock: { increment: quantity } },
        create: { productId, locationId: toId, tenantId: req.tenantId, stock: quantity },
      })

      // Registrar la transferencia
      const t = await tx.stockTransfer.create({
        data: {
          tenantId:    req.tenantId,
          fromId,
          toId,
          productId,
          productName: product.name,
          quantity,
          reason,
          userId:      req.user.id,
          status:      'completada',
        },
      })

      return t
    })

    return sendOk(reply, transfer, null, 201)
  })

  // GET /api/locations/transfers — historial de transferencias
  fastify.get('/locations/transfers', { preHandler: PRE }, async (req, reply) => {
    const { productId, fromId, toId, page = '1', limit = '50' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      tenantId: req.tenantId,
      ...(productId && { productId }),
      ...(fromId    && { fromId }),
      ...(toId      && { toId }),
    }

    const [transfers, total] = await Promise.all([
      prisma.stockTransfer.findMany({
        where,
        skip,
        take:    parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          from:    { select: { name: true, type: true } },
          to:      { select: { name: true, type: true } },
          product: { select: { name: true, unit: true } },
          user:    { select: { fullName: true } },
        },
      }),
      prisma.stockTransfer.count({ where }),
    ])

    return sendOk(reply, transfers, { total })
  })

  // DELETE /api/locations/transfers/:id — anular transferencia (revierte stock)
  fastify.delete('/locations/transfers/:id', { preHandler: PRE }, async (req, reply) => {
    const transfer = await prisma.stockTransfer.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!transfer) return send404(reply, 'Transferencia')
    if (transfer.status === 'anulada') return send409(reply, 'Esta transferencia ya fue anulada')

    await prisma.$transaction(async (tx) => {
      // Revertir: devolver al origen, quitar del destino
      await tx.productLocation.updateMany({
        where: { productId: transfer.productId, locationId: transfer.fromId },
        data:  { stock: { increment: transfer.quantity } },
      })
      await tx.productLocation.updateMany({
        where: { productId: transfer.productId, locationId: transfer.toId },
        data:  { stock: { decrement: transfer.quantity } },
      })
      await tx.stockTransfer.update({
        where: { id: transfer.id },
        data:  { status: 'anulada' },
      })
    })

    return sendOk(reply, { id: transfer.id, status: 'anulada' })
  })
}
