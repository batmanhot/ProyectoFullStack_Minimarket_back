import { z }    from 'zod'
import prisma    from '../db.js'
import { requireAuth }    from '../middlewares/auth.js'
import { resolveTenant }  from '../middlewares/tenant.js'
import { sendOk, sendError, send404 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

// ── Schemas Zod ──────────────────────────────────────────────────────────────
const productSchema = z.object({
  name:         z.string().min(1),
  barcode:      z.string().default(''),
  sku:          z.string().default(''),
  categoryId:   z.string().default(''),
  // brandId acepta tanto "brandId" como el alias "brand" que manda el frontend
  brandId:      z.string().default('').optional(),
  brand:        z.string().default('').optional(),
  supplierId:   z.string().default('').optional(),
  description:  z.string().default(''),
  // El frontend manda 'simple' como alias de 'normal'
  type:         z.enum(['normal','bundle','service','simple']).default('normal'),
  priceSell:    z.number().min(0),
  priceBuy:     z.number().min(0).default(0),
  margin:       z.number().default(0),
  stock:        z.number().default(0),
  stockMin:     z.number().default(0),
  stockMax:     z.number().default(0).optional(),
  unit:         z.string().default('unidad'),
  stockControl: z.enum(['simple','lote_fefo','lote_fifo','serie']).default('simple'),
  hasVariants:  z.boolean().default(false),
  isActive:     z.boolean().default(true),
  imageUrl:     z.string().default('').optional(),
  location:     z.string().default('').optional(),
  expiryDate:   z.string().default('').optional(),
  attributes:   z.record(z.any()).default({}).optional(),
  // Relaciones opcionales
  batches:      z.array(z.any()).optional(),
  variants:     z.array(z.any()).optional(),
  components:   z.array(z.object({ productId: z.string(), quantity: z.number() })).optional(),
})

// Normaliza los campos del frontend al formato del backend.
// Usa whitelist explícita para evitar que campos desconocidos lleguen a Prisma.
function normalizeProductData(raw) {
  const r = raw || {}
  return {
    data: {
      name:         String(r.name        || ''),
      barcode:      String(r.barcode     || ''),
      sku:          String(r.sku         || ''),
      description:  String(r.description || ''),
      categoryId:   String(r.categoryId  || ''),
      brandId:      String(r.brandId || r.brand || ''),
      supplierId:   String(r.supplierId  || ''),
      // 'simple' en frontend = 'normal' en backend; bundle se guarda tal cual
      type:         (r.type === 'simple' ? 'normal' : (r.type || 'normal')),
      priceSell:    Number(r.priceSell)  || 0,
      priceBuy:     Number(r.priceBuy)   || 0,
      margin:       Number(r.margin)     || 0,
      stock:        Number(r.stock)      || 0,
      stockMin:     Number(r.stockMin)   || 0,
      stockMax:     Number(r.stockMax)   || 0,
      unit:         String(r.unit        || 'unidad'),
      stockControl: String(r.stockControl || 'simple'),
      hasVariants:  Boolean(r.hasVariants ?? false),
      isActive:     r.isActive === undefined ? true : Boolean(r.isActive),
      imageUrl:     String(r.imageUrl    || ''),
      location:     String(r.location    || ''),
      expiryDate:   String(r.expiryDate  || ''),
      attributes:   (typeof r.attributes === 'object' && r.attributes !== null) ? r.attributes : {},
    },
    batches:    Array.isArray(r.batches)    ? r.batches    : undefined,
    variants:   Array.isArray(r.variants)   ? r.variants   : undefined,
    components: Array.isArray(r.components) ? r.components : undefined,
  }
}

export default async function productsRoutes(fastify) {

  // GET /api/products
  fastify.get('/products', { preHandler: PRE }, async (req, reply) => {
    const { search, categoryId, lowStock, nearExpiry, noMovement, page = '1', limit = '200' } = req.query
    const tenantId = req.tenantId
    const skip = (parseInt(page) - 1) * parseInt(limit)

    // Prisma no soporta comparar dos columnas en WHERE (stock <= stockMin),
    // los filtros lowStock y nearExpiry se aplican en memoria después del fetch.
    const where = {
      tenantId,
      isActive: true,
      ...(categoryId && { categoryId }),
      ...(search && {
        OR: [
          { name:    { contains: search, mode: 'insensitive' } },
          { barcode: { contains: search } },
          { sku:     { contains: search, mode: 'insensitive' } },
        ],
      }),
    }

    const products = await prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        batches:       true,
        variants:      true,
        bundleParents: { include: { product: { select: { id: true, name: true, stock: true } } } },
      },
    })

    // Filtros en memoria
    let list = products
    if (lowStock === 'true') {
      list = list.filter(p => p.stock <= p.stockMin)
    }
    if (nearExpiry === 'true') {
      const limit30 = new Date(Date.now() + 30 * 86400_000)
      list = list.filter(p =>
        p.batches?.some(b => b.expiryDate && new Date(b.expiryDate) <= limit30 && b.status === 'activo')
      )
    }

    // Paginación aplicada después de los filtros
    const total    = list.length
    const paginated = list.slice(skip, skip + parseInt(limit))

    // Mapear bundleParents→components y number→batchNumber para el frontend
    const mapped = paginated.map(p => ({
      ...p,
      batches: (p.batches || []).map(b => ({ ...b, batchNumber: b.number })),
      components: p.bundleParents?.map(bc => ({
        productId: bc.productId,
        quantity:  bc.quantity,
        name:      bc.product?.name,
      })) ?? [],
    }))

    return sendOk(reply, mapped, { total })
  })

  // GET /api/products/barcode/:barcode
  fastify.get('/products/barcode/:barcode', { preHandler: PRE }, async (req, reply) => {
    const product = await prisma.product.findFirst({
      where: { tenantId: req.tenantId, barcode: req.params.barcode, isActive: true },
      include: { batches: true, variants: true },
    })
    if (!product) return send404(reply, 'Producto')
    return sendOk(reply, product)
  })

  // POST /api/products
  fastify.post('/products', { preHandler: PRE }, async (req, reply) => {
    // Validación mínima de campos requeridos
    if (!req.body?.name) return sendError(reply, 'El nombre del producto es requerido')

    const { data, batches, variants, components } = normalizeProductData(req.body)

    const product = await prisma.product.create({
      data: {
        ...data,
        tenantId: req.tenantId,
        // Spread condicional: si no hay datos NO incluir la clave (Prisma 5 rechaza undefined en relaciones)
        ...(batches?.length && {
          batches: { create: batches.map(b => ({ number: b.number || '', quantity: b.quantity || 0, expiryDate: b.expiryDate ? new Date(b.expiryDate) : null, status: b.status || 'activo' })) }
        }),
        ...(variants?.length && {
          variants: { create: variants.map(v => ({ name: v.name, sku: v.sku || '', stock: v.stock || 0, priceSell: v.priceSell || null })) }
        }),
        ...(components?.length && {
          bundleParents: { create: components.map(c => ({ productId: c.productId, quantity: c.quantity })) }
        }),
      },
      include: {
        batches:  true,
        variants: true,
        bundleParents: { include: { product: { select: { id: true, name: true, barcode: true, unit: true, priceSell: true, stock: true } } } },
      },
    })
    return sendOk(reply, product, null, 201)
  })

  // PUT /api/products/:id
  fastify.put('/products/:id', { preHandler: PRE }, async (req, reply) => {
    const { id } = req.params

    const existing = await prisma.product.findFirst({ where: { id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Producto')

    const { data, batches, variants, components } = normalizeProductData(req.body)

    // Actualizar en transacción para manejar relaciones
    const product = await prisma.$transaction(async (tx) => {
      if (batches !== undefined) {
        await tx.productBatch.deleteMany({ where: { productId: id } })
        if (batches.length) {
          await tx.productBatch.createMany({
            data: batches.map(b => ({
              productId: id,
              number:    b.number || '',
              quantity:  b.quantity ?? 0,
              expiryDate:b.expiryDate ? new Date(b.expiryDate) : null,
              status:    b.status || 'activo',
            })),
          })
        }
      }

      if (variants !== undefined) {
        await tx.productVariant.deleteMany({ where: { productId: id } })
        if (variants.length) {
          await tx.productVariant.createMany({
            data: variants.map(v => ({
              productId: id,
              name:      v.name,
              sku:       v.sku || '',
              stock:     v.stock ?? 0,
              priceSell: v.priceSell ?? null,
            })),
          })
        }
      }

      if (components !== undefined) {
        await tx.bundleComponent.deleteMany({ where: { bundleId: id } })
        if (components.length) {
          await tx.bundleComponent.createMany({
            data: components.map(c => ({ bundleId: id, productId: c.productId, quantity: c.quantity })),
          })
        }
      }

      return tx.product.update({
        where: { id },
        data:  { ...data, updatedAt: new Date() },
        include: {
          batches:  true,
          variants: true,
          bundleParents: { include: { product: { select: { id: true, name: true, barcode: true, unit: true, priceSell: true, stock: true } } } },
        },
      })
    })

    return sendOk(reply, product)
  })

  // DELETE /api/products/:id  (soft delete)
  fastify.delete('/products/:id', { preHandler: PRE }, async (req, reply) => {
    const existing = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!existing) return send404(reply, 'Producto')
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } })
    return sendOk(reply, { id: req.params.id, deleted: true })
  })

  // ── LOTES ─────────────────────────────────────────────────────────────────────
  // POST /api/products/:id/batches
  fastify.post('/products/:id/batches', { preHandler: PRE }, async (req, reply) => {
    const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!product) return send404(reply, 'Producto')
    const { batchNumber, quantity, priceBuy, expiryDate, notes } = req.body
    if (!batchNumber?.trim()) return sendError(reply, 'El N° de lote es requerido')
    const batch = await prisma.productBatch.create({
      data: {
        productId:  req.params.id,
        number:     batchNumber.trim(),
        quantity:   parseFloat(quantity)  || 0,
        priceBuy:   parseFloat(priceBuy)  || 0,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        notes:      notes || '',
        status:     'activo',
      },
    })
    return sendOk(reply, { ...batch, batchNumber: batch.number }, null, 201)
  })

  // PUT /api/products/:id/batches/:batchId
  fastify.put('/products/:id/batches/:batchId', { preHandler: PRE }, async (req, reply) => {
    const batch = await prisma.productBatch.findUnique({ where: { id: req.params.batchId } })
    if (!batch) return send404(reply, 'Lote')
    const { batchNumber, quantity, priceBuy, expiryDate, notes, status } = req.body
    const updated = await prisma.productBatch.update({
      where: { id: req.params.batchId },
      data: {
        ...(batchNumber !== undefined && { number: batchNumber }),
        ...(quantity    !== undefined && { quantity:   parseFloat(quantity) }),
        ...(priceBuy    !== undefined && { priceBuy:   parseFloat(priceBuy) }),
        ...(expiryDate  !== undefined && { expiryDate: expiryDate ? new Date(expiryDate) : null }),
        ...(notes       !== undefined && { notes }),
        ...(status      !== undefined && { status }),
      },
    })
    return sendOk(reply, { ...updated, batchNumber: updated.number })
  })

  // DELETE /api/products/:id/batches/:batchId
  fastify.delete('/products/:id/batches/:batchId', { preHandler: PRE }, async (req, reply) => {
    await prisma.productBatch.delete({ where: { id: req.params.batchId } })
    return sendOk(reply, { deleted: true })
  })

  // POST /api/products/:id/stock  — ajuste manual de stock
  fastify.post('/products/:id/stock', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      quantity: z.number().positive(),
      type:     z.enum(['entrada', 'salida']),
      reason:   z.string().default('Ajuste manual'),
      batchData:z.object({ number: z.string(), expiryDate: z.string().optional(), status: z.string().default('activo') }).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Datos inválidos')

    const { quantity, type, reason, batchData } = parsed.data
    const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, include: { batches: true } })
    if (!product) return send404(reply, 'Producto')

    const delta    = type === 'entrada' ? quantity : -quantity
    const prevStock = product.stock
    const newStock  = Math.max(0, prevStock + delta)

    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: product.id }, data: { stock: newStock } })

      // Si tiene control por lote y es entrada, crear o actualizar el lote
      if (type === 'entrada' && batchData && (product.stockControl === 'lote_fefo' || product.stockControl === 'lote_fifo')) {
        const existingBatch = product.batches.find(b => b.number === batchData.number)
        if (existingBatch) {
          await tx.productBatch.update({
            where: { id: existingBatch.id },
            data:  { quantity: existingBatch.quantity + quantity, status: 'activo' },
          })
        } else {
          await tx.productBatch.create({
            data: {
              productId:  product.id,
              number:     batchData.number,
              quantity,
              expiryDate: batchData.expiryDate ? new Date(batchData.expiryDate) : null,
              status:     batchData.status,
            },
          })
        }
      }

      await tx.stockMovement.create({
        data: {
          tenantId:     req.tenantId,
          productId:    product.id,
          productName:  product.name,
          type,
          quantity,
          previousStock: prevStock,
          newStock,
          reason,
          userId:       req.user.id,
        },
      })
    })

    return sendOk(reply, { id: product.id, newStock })
  })
}
