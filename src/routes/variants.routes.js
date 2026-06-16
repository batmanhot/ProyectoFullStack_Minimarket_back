/**
 * variants.routes.js
 * CRUD completo de variantes de producto (tallas, colores, capacidades, etc.)
 *
 * GET    /api/products/:productId/variants        → lista variantes del producto
 * POST   /api/products/:productId/variants        → crear variante
 * PUT    /api/products/:productId/variants/:id    → actualizar variante
 * PATCH  /api/products/:productId/variants/:id/stock → ajustar stock de variante
 * DELETE /api/products/:productId/variants/:id    → desactivar variante
 */
import { z }           from 'zod'
import prisma          from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'

const PRE     = [requireAuth, resolveTenant]
const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

const variantCreateSchema = z.object({
  name:       z.string().min(1),
  sku:        z.string().default(''),
  barcode:    z.string().default(''),
  stock:      z.number().min(0).default(0),
  stockMin:   z.number().min(0).default(2),
  priceSell:  z.number().min(0).optional(),
  attributes: z.record(z.string()).default({}), // { "talla": "L", "color": "rojo" }
  isActive:   z.boolean().default(true),
})

const variantUpdateSchema = z.object({
  name:      z.string().min(1).optional(),
  sku:       z.string().optional(),
  barcode:   z.string().optional(),
  stockMin:  z.number().min(0).optional(),
  priceSell: z.number().min(0).optional(),
  attributes:z.record(z.string()).optional(),
  isActive:  z.boolean().optional(),
})

export default async function variantsRoutes(fastify) {

  // GET /api/products/:productId/variants
  fastify.get('/products/:productId/variants', { preHandler: PRE }, async (req, reply) => {
    const product = await prisma.product.findFirst({
      where: { id: req.params.productId, tenantId: req.tenantId },
    })
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' })

    const variants = await prisma.productVariant.findMany({
      where:   { productId: req.params.productId },
      orderBy: { createdAt: 'asc' },
    })

    return reply.send({
      data: variants,
      product: { id: product.id, name: product.name, hasVariants: product.hasVariants },
      meta: { total: variants.length },
    })
  })

  // POST /api/products/:productId/variants
  fastify.post('/products/:productId/variants', { preHandler: PRE }, async (req, reply) => {
    const parsed = variantCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    const product = await prisma.product.findFirst({
      where:   { id: req.params.productId, tenantId: req.tenantId },
      include: { variants: true },
    })
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' })

    // Si el barcode no está vacío, verificar unicidad dentro del tenant
    if (parsed.data.barcode) {
      const barcodeConflict = await prisma.productVariant.findFirst({
        where: {
          barcode:   parsed.data.barcode,
          product:   { tenantId: req.tenantId },
          id:        { not: 'none' },
        },
      })
      if (barcodeConflict) {
        return reply.code(409).send({ error: `El barcode "${parsed.data.barcode}" ya está en uso por otra variante` })
      }
    }

    const variant = await prisma.$transaction(async (tx) => {
      const newVariant = await tx.productVariant.create({
        data: { ...parsed.data, productId: req.params.productId },
      })

      // Asegurar que el producto padre tenga hasVariants = true
      if (!product.hasVariants) {
        await tx.product.update({
          where: { id: product.id },
          data:  { hasVariants: true },
        })
      }

      // Recalcular stock del producto = suma de stocks de todas sus variantes
      const allVariants = [...product.variants, { ...newVariant }]
      const totalStock = allVariants
        .filter(v => v.isActive)
        .reduce((s, v) => s + (v.stock ?? 0), 0)

      await tx.product.update({
        where: { id: product.id },
        data:  { stock: totalStock },
      })

      // Registrar movimiento de stock inicial si stock > 0
      if (parsed.data.stock > 0) {
        await tx.stockMovement.create({
          data: {
            tenantId:     req.tenantId,
            productId:    product.id,
            productName:  product.name,
            variantId:    newVariant.id,
            type:         'entrada',
            quantity:     parsed.data.stock,
            previousStock:0,
            newStock:     parsed.data.stock,
            reason:       `Stock inicial variante: ${parsed.data.name}`,
            userId:       req.user.id,
          },
        })
      }

      return newVariant
    })

    return reply.code(201).send({ data: variant })
  })

  // PUT /api/products/:productId/variants/:id
  fastify.put('/products/:productId/variants/:id', { preHandler: PRE }, async (req, reply) => {
    const variant = await prisma.productVariant.findFirst({
      where: { id: req.params.id, productId: req.params.productId },
    })
    if (!variant) return reply.code(404).send({ error: 'Variante no encontrada' })

    const parsed = variantUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    const updated = await prisma.productVariant.update({
      where: { id: variant.id },
      data:  { ...parsed.data, updatedAt: new Date() },
    })

    // Si se desactivó la variante, recalcular stock del padre
    if (parsed.data.isActive === false) {
      const siblings = await prisma.productVariant.findMany({
        where: { productId: req.params.productId },
      })
      const totalStock = siblings
        .map(v => v.id === updated.id ? updated : v)
        .filter(v => v.isActive)
        .reduce((s, v) => s + (v.stock ?? 0), 0)
      await prisma.product.update({
        where: { id: req.params.productId },
        data:  { stock: totalStock },
      })
    }

    return reply.send({ data: updated })
  })

  // PATCH /api/products/:productId/variants/:id/stock — ajuste manual de stock
  fastify.patch('/products/:productId/variants/:id/stock', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      quantity: z.number().positive(),
      type:     z.enum(['entrada', 'salida']),
      reason:   z.string().min(1).default('Ajuste manual'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos' })
    }

    const variant = await prisma.productVariant.findFirst({
      where: { id: req.params.id, productId: req.params.productId },
    })
    if (!variant) return reply.code(404).send({ error: 'Variante no encontrada' })

    const product = await prisma.product.findFirst({
      where:   { id: req.params.productId, tenantId: req.tenantId },
      include: { variants: true },
    })
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' })

    const prevStock = variant.stock ?? 0
    const delta     = parsed.data.type === 'entrada' ? parsed.data.quantity : -parsed.data.quantity
    const newStock  = Math.max(0, prevStock + delta)

    await prisma.$transaction(async (tx) => {
      await tx.productVariant.update({
        where: { id: variant.id },
        data:  { stock: newStock, updatedAt: new Date() },
      })

      // Recalcular stock del producto padre
      const totalStock = product.variants
        .map(v => v.id === variant.id ? { ...v, stock: newStock } : v)
        .filter(v => v.isActive)
        .reduce((s, v) => s + (v.stock ?? 0), 0)

      await tx.product.update({
        where: { id: product.id },
        data:  { stock: totalStock },
      })

      await tx.stockMovement.create({
        data: {
          tenantId:     req.tenantId,
          productId:    product.id,
          productName:  product.name,
          variantId:    variant.id,
          type:         parsed.data.type,
          quantity:     parsed.data.quantity,
          previousStock:prevStock,
          newStock,
          reason:       parsed.data.reason,
          userId:       req.user.id,
        },
      })
    })

    return reply.send({ data: { id: variant.id, stock: newStock } })
  })

  // DELETE /api/products/:productId/variants/:id  (soft delete)
  fastify.delete('/products/:productId/variants/:id', { preHandler: PRE }, async (req, reply) => {
    const variant = await prisma.productVariant.findFirst({
      where: { id: req.params.id, productId: req.params.productId },
    })
    if (!variant) return reply.code(404).send({ error: 'Variante no encontrada' })

    await prisma.$transaction(async (tx) => {
      await tx.productVariant.update({
        where: { id: variant.id },
        data:  { isActive: false, updatedAt: new Date() },
      })

      // Recalcular stock del producto padre excluyendo la variante desactivada
      const siblings = await tx.productVariant.findMany({
        where: { productId: req.params.productId, isActive: true, id: { not: variant.id } },
      })
      const totalStock = siblings.reduce((s, v) => s + (v.stock ?? 0), 0)

      await tx.product.update({
        where: { id: req.params.productId },
        data:  { stock: totalStock },
      })
    })

    return reply.send({ data: { id: variant.id, deleted: true } })
  })
}
