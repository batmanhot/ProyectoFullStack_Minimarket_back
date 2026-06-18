/**
 * serials.routes.js
 * Control de stock por número de serie (stockControl = 'serie').
 *
 * GET  /api/products/:productId/serials         → lista seriales del producto
 * POST /api/products/:productId/serials         → registrar uno o varios seriales
 * GET  /api/products/serial/:serialNumber       → buscar por número de serie (validación BD)
 * PATCH /api/products/:productId/serials/:id    → cambiar estado (dar de baja, etc.)
 * DELETE /api/products/:productId/serials/:id   → eliminar serial (solo si disponible)
 *
 * Integración con ventas:
 *   Al vender un producto tipo 'serie', sales.routes.js llama a markSerialSold()
 *   exportada de este archivo. Al cancelar, llama a markSerialAvailable().
 */
import { z }           from 'zod'
import prisma          from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]

// ── Helpers exportados para uso en sales.routes.js ───────────────────────────
export async function markSerialSold({ tenantId, serialNumber, saleId, invoiceNumber }) {
  return prisma.productSerial.updateMany({
    where: { tenantId, serialNumber, status: 'disponible' },
    data:  { status: 'vendido', saleId, invoiceNumber, soldAt: new Date() },
  })
}

export async function markSerialAvailable({ tenantId, serialNumber }) {
  return prisma.productSerial.updateMany({
    where: { tenantId, serialNumber },
    data:  { status: 'disponible', saleId: '', invoiceNumber: '', soldAt: null },
  })
}

export async function getAvailableSerial({ tenantId, productId }) {
  return prisma.productSerial.findFirst({
    where: { tenantId, productId, status: 'disponible' },
    orderBy: { createdAt: 'asc' },
  })
}

export default async function serialsRoutes(fastify) {

  // GET /api/products/:productId/serials
  fastify.get('/products/:productId/serials', { preHandler: PRE }, async (req, reply) => {
    const { status, page = '1', limit = '100' } = req.query
    const product = await prisma.product.findFirst({
      where: { id: req.params.productId, tenantId: req.tenantId },
    })
    if (!product) return send404(reply, 'Producto')

    const where = {
      productId: req.params.productId,
      tenantId:  req.tenantId,
      ...(status && { status }),
    }

    const [serials, total] = await Promise.all([
      prisma.productSerial.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.productSerial.count({ where }),
    ])

    const summary = {
      disponible: await prisma.productSerial.count({ where: { productId: req.params.productId, tenantId: req.tenantId, status: 'disponible' } }),
      vendido:    await prisma.productSerial.count({ where: { productId: req.params.productId, tenantId: req.tenantId, status: 'vendido' } }),
      dado_baja:  await prisma.productSerial.count({ where: { productId: req.params.productId, tenantId: req.tenantId, status: 'dado_baja' } }),
    }

    return sendOk(reply, serials, { total, summary })
  })

  // POST /api/products/:productId/serials  — registrar uno o varios seriales nuevos
  fastify.post('/products/:productId/serials', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      // Permite registrar un solo serial o un lote (array)
      serials: z.array(z.object({
        serialNumber: z.string().min(1),
        notes:        z.string().default(''),
      })).min(1).max(500),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    }

    const product = await prisma.product.findFirst({
      where: { id: req.params.productId, tenantId: req.tenantId },
    })
    if (!product) return send404(reply, 'Producto')
    if (product.stockControl !== 'serie') {
      return sendError(reply, `Este producto usa control "${product.stockControl}", no "serie"`)
    }

    // Verificar duplicados dentro del batch entrante
    const incoming = parsed.data.serials.map(s => s.serialNumber)
    const unique   = new Set(incoming)
    if (unique.size !== incoming.length) {
      return sendError(reply, 'El lote contiene números de serie duplicados entre sí')
    }

    // Verificar duplicados contra la BD
    const existing = await prisma.productSerial.findMany({
      where: { tenantId: req.tenantId, serialNumber: { in: incoming } },
      select: { serialNumber: true },
    })
    if (existing.length > 0) {
      return reply.code(409).send({
        error: `${existing.length} serial(es) ya existen en este tenant`,
        duplicates: existing.map(e => e.serialNumber),
      })
    }

    // Crear todos en una sola operación
    await prisma.productSerial.createMany({
      data: parsed.data.serials.map(s => ({
        tenantId:     req.tenantId,
        productId:    req.params.productId,
        serialNumber: s.serialNumber,
        notes:        s.notes,
        status:       'disponible',
      })),
    })

    // Actualizar stock del producto = cantidad de seriales disponibles
    const disponibles = await prisma.productSerial.count({
      where: { productId: req.params.productId, tenantId: req.tenantId, status: 'disponible' },
    })
    await prisma.product.update({
      where: { id: req.params.productId },
      data:  { stock: disponibles },
    })

    return sendOk(reply, { created: parsed.data.serials.length, stockUpdated: disponibles }, null, 201)
  })

  // GET /api/products/serial/:serialNumber  — buscar por serial (validación en venta)
  fastify.get('/products/serial/:serialNumber', { preHandler: PRE }, async (req, reply) => {
    const serial = await prisma.productSerial.findFirst({
      where: {
        tenantId:     req.tenantId,
        serialNumber: req.params.serialNumber,
      },
      include: {
        product: {
          select: { id: true, name: true, priceSell: true, stockControl: true, isActive: true },
        },
      },
    })

    if (!serial) return send404(reply, `Serial "${req.params.serialNumber}"`)

    // En validación para venta, informar si ya está vendido
    if (serial.status === 'vendido') {
      return reply.code(409).send({
        error:         `Serial ya vendido en comprobante ${serial.invoiceNumber}`,
        status:        'vendido',
        invoiceNumber: serial.invoiceNumber,
        soldAt:        serial.soldAt,
      })
    }

    if (serial.status === 'dado_baja') {
      return reply.code(409).send({ error: 'Este serial ha sido dado de baja', status: 'dado_baja' })
    }

    return sendOk(reply, serial)
  })

  // PATCH /api/products/:productId/serials/:id  — cambiar estado manualmente
  fastify.patch('/products/:productId/serials/:id', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      status: z.enum(['disponible', 'reservado', 'dado_baja']),
      notes:  z.string().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Estado inválido')

    const serial = await prisma.productSerial.findFirst({
      where: { id: req.params.id, productId: req.params.productId, tenantId: req.tenantId },
    })
    if (!serial) return send404(reply, 'Serial')
    if (serial.status === 'vendido') {
      return send409(reply, 'No se puede cambiar el estado de un serial vendido')
    }

    const updated = await prisma.productSerial.update({
      where: { id: serial.id },
      data:  {
        status: parsed.data.status,
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
      },
    })

    // Recalcular stock disponible
    const disponibles = await prisma.productSerial.count({
      where: { productId: req.params.productId, tenantId: req.tenantId, status: 'disponible' },
    })
    await prisma.product.update({
      where: { id: req.params.productId },
      data:  { stock: disponibles },
    })

    return sendOk(reply, updated)
  })

  // DELETE /api/products/:productId/serials/:id
  fastify.delete('/products/:productId/serials/:id', { preHandler: PRE }, async (req, reply) => {
    const serial = await prisma.productSerial.findFirst({
      where: { id: req.params.id, productId: req.params.productId, tenantId: req.tenantId },
    })
    if (!serial) return send404(reply, 'Serial')
    if (serial.status === 'vendido') {
      return send409(reply, 'No se puede eliminar un serial vendido. Usa "dado de baja".')
    }

    await prisma.productSerial.delete({ where: { id: serial.id } })

    const disponibles = await prisma.productSerial.count({
      where: { productId: req.params.productId, tenantId: req.tenantId, status: 'disponible' },
    })
    await prisma.product.update({ where: { id: req.params.productId }, data: { stock: disponibles } })

    return sendOk(reply, { id: serial.id, deleted: true })
  })
}
