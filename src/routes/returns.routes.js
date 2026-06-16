import { z }   from 'zod'
import prisma   from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { restoreStock }  from '../services/inventory.service.js'
import { nextInvoiceNumber } from '../utils/invoiceCounter.js'

const PRE = [requireAuth, resolveTenant]
const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

export default async function returnsRoutes(fastify) {

  fastify.get('/returns', { preHandler: PRE }, async (req, reply) => {
    const { status, saleId, dateFrom, dateTo, page = '1', limit = '100' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const where = {
      tenantId: req.tenantId,
      ...(status   && { status }),
      ...(saleId   && { saleId }),
      ...(dateFrom && { createdAt: { gte: new Date(dateFrom) } }),
      ...(dateTo   && { createdAt: { lte: new Date(dateTo) } }),
    }
    const [returns, total] = await Promise.all([
      prisma.return.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { items: true },
      }),
      prisma.return.count({ where }),
    ])
    return reply.send({ data: returns, meta: { total } })
  })

  fastify.get('/returns/:id', { preHandler: PRE }, async (req, reply) => {
    const ret = await prisma.return.findFirst({
      where:   { id: req.params.id, tenantId: req.tenantId },
      include: { items: true },
    })
    if (!ret) return reply.code(404).send({ error: 'Devolución no encontrada' })
    return reply.send({ data: ret })
  })

  fastify.post('/returns', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      saleId:          z.string().uuid().optional(),
      invoiceNumber:   z.string().default(''),
      tipoComprobante: z.string().default('nc'),
      clientId:        z.string().uuid().optional(),
      clientName:      z.string().default(''),
      reason:          z.string().min(1),
      reasonLabel:     z.string().default(''),
      reasonNote:      z.string().default(''),
      totalRefund:     z.number().min(0),
      igvRate:         z.number().default(0.18),
      items: z.array(z.object({
        saleItemId:   z.string().optional().nullable(),
        productId:    z.string(),
        productName:  z.string(),
        barcode:      z.string().nullable().default(''),
        quantity:     z.number().positive(),
        unitPrice:    z.number().min(0),
        netUnitPrice: z.number().min(0),
        discount:     z.number().default(0),
        totalRefund:  z.number().min(0),
        unit:         z.string().default('unidad'),
        batchId:      z.string().nullable().default(''),
        batchNumber:  z.string().nullable().default(''),
        expiryDate:   z.string().nullable().default(''),
      })).min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Datos inválidos', details: parsed.error.flatten() })
    const d = parsed.data

    const igvRate       = d.igvRate
    const totalRefund   = HALF_UP(d.totalRefund)
    const baseImponible = HALF_UP(totalRefund / (1 + igvRate))
    const igv           = HALF_UP(totalRefund - baseImponible)

    const ret = await prisma.$transaction(async (tx) => {
      const ncNumber = await nextInvoiceNumber(tx, req.tenantId, 'nc')

      const newReturn = await tx.return.create({
        data: {
          tenantId:       req.tenantId,
          ncNumber,
          saleId:         d.saleId || null,
          invoiceNumber:  d.invoiceNumber,
          tipoComprobante:d.tipoComprobante,
          clientId:       d.clientId || null,
          clientName:     d.clientName,
          userId:         req.user.id,
          userName:       req.user.fullName || '',
          reason:         d.reason,
          reasonLabel:    d.reasonLabel,
          reasonNote:     d.reasonNote,
          totalRefund,
          baseImponible,
          igv,
          igvRate,
          status:         'completada',
          sunatStatus:    'pendiente',
          items: {
            create: d.items.map(i => ({
              saleItemId:  i.saleItemId || '',
              productId:   i.productId,
              productName: i.productName,
              barcode:     i.barcode,
              quantity:    i.quantity,
              unitPrice:   i.unitPrice,
              netUnitPrice:i.netUnitPrice,
              discount:    i.discount,
              totalRefund: i.totalRefund,
              unit:        i.unit,
              batchId:     i.batchId,
              batchNumber: i.batchNumber,
              expiryDate:  i.expiryDate,
            })),
          },
        },
        include: { items: true },
      })

      // Restaurar stock por cada ítem devuelto
      for (const item of d.items) {
        const product = await tx.product.findFirst({
          where:   { id: item.productId, tenantId: req.tenantId },
          include: { batches: true },
        })
        if (!product) continue

        const prevStock = product.stock

        await restoreStock({
          product,
          item: {
            variantId:        null,
            quantity:         item.quantity,
            stockControlUsed: product.stockControl,
            batchAllocations: item.batchId
              ? [{ batchId: item.batchId, batchNumber: item.batchNumber, quantity: item.quantity }]
              : [],
          },
        })

        await tx.stockMovement.create({
          data: {
            tenantId:     req.tenantId,
            productId:    product.id,
            productName:  product.name,
            type:         'entrada',
            quantity:     item.quantity,
            previousStock:prevStock,
            newStock:     prevStock + item.quantity,
            reason:       `Devolución ${ncNumber}`,
            invoiceNumber:d.invoiceNumber,
            userId:       req.user.id,
          },
        })
      }

      // Revertir deuda de crédito si la venta original tenía crédito
      if (d.saleId && d.clientId) {
        const origSale = await tx.sale.findUnique({
          where: { id: d.saleId }, include: { payments: true },
        })
        const creditPmt = origSale?.payments?.find(p => p.method === 'credito')
        if (creditPmt) {
          const refundPct = totalRefund / (origSale?.total || 1)
          const debtReduction = HALF_UP(creditPmt.amount * refundPct)
          await tx.client.update({
            where: { id: d.clientId },
            data:  { currentDebt: { decrement: debtReduction } },
          })
        }
      }

      // Actualizar estado de la venta original
      if (d.saleId) {
        const origSale = await tx.sale.findUnique({ where: { id: d.saleId } })
        if (origSale && origSale.status === 'completada') {
          const allReturns = await tx.return.findMany({
            where: { saleId: d.saleId, status: 'completada' },
          })
          const totalDevuelto = allReturns.reduce((s, r) => s + r.totalRefund, 0) + totalRefund
          const newStatus = totalDevuelto >= origSale.total ? 'devolucion' : 'dev-parcial'
          await tx.sale.update({ where: { id: d.saleId }, data: { status: newStatus } })
        }
      }

      return newReturn
    })

    return reply.code(201).send({ data: ret })
  })

  // PATCH /api/returns/:id/anular
  fastify.patch('/returns/:id/anular', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({ motivo: z.string().min(1) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Se requiere motivo de anulación' })

    const ret = await prisma.return.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!ret) return reply.code(404).send({ error: 'Devolución no encontrada' })
    if (ret.status === 'anulada') return reply.code(409).send({ error: 'Esta devolución ya está anulada' })

    const updated = await prisma.return.update({
      where: { id: ret.id },
      data:  { status: 'anulada', anulatedAt: new Date(), anulationReason: parsed.data.motivo },
    })
    return reply.send({ data: { id: updated.id, status: updated.status } })
  })
}
