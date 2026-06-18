import { z }    from 'zod'
import prisma    from '../db.js'
import { requireAuth }    from '../middlewares/auth.js'
import { resolveTenant }  from '../middlewares/tenant.js'
import { allocateStock, restoreStock, calcPointsEarned, calcLoyaltyLevel } from '../services/inventory.service.js'
import { nextInvoiceNumber } from '../utils/invoiceCounter.js'
import { DISCOUNT } from '../config/businessRules.js'
import { sendOk, sendError, send404, send409 } from '../utils/response.js'

const PRE = [requireAuth, resolveTenant]
const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

export default async function salesRoutes(fastify) {

  // GET /api/sales
  fastify.get('/sales', { preHandler: PRE }, async (req, reply) => {
    const { status, clientId, dateFrom, dateTo, page = '1', limit = '100' } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      tenantId: req.tenantId,
      ...(status   && { status }),
      ...(clientId && { clientId }),
      ...(dateFrom && { createdAt: { gte: new Date(dateFrom) } }),
      ...(dateTo   && { createdAt: { lte: new Date(dateTo) } }),
    }

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          items:    { include: { batchAllocations: true } },
          payments: true,
        },
      }),
      prisma.sale.count({ where }),
    ])

    return sendOk(reply, sales, { total })
  })

  // GET /api/sales/:id
  fastify.get('/sales/:id', { preHandler: PRE }, async (req, reply) => {
    const sale = await prisma.sale.findFirst({
      where:   { id: req.params.id, tenantId: req.tenantId },
      include: { items: { include: { batchAllocations: true } }, payments: true },
    })
    if (!sale) return send404(reply, 'Venta')
    return sendOk(reply, sale)
  })

  // POST /api/sales
  fastify.post('/sales', { preHandler: PRE }, async (req, reply) => {
    const body = req.body
    if (!body?.items?.length) return sendError(reply, 'La venta debe tener al menos un ítem')
    if (!body?.payments?.length && (body?.total ?? 0) > 0) {
      return sendError(reply, 'La venta debe tener al menos un método de pago')
    }

    // ── Validar descuento máximo por ítem ────────────────────────────────────
    // DISCOUNT.HARD_MAX_PCT es el límite absoluto del backend (100%).
    // El límite por tenant (ej: 50%) lo valida el frontend; aquí solo bloqueamos
    // payloads manipulados que intenten superar el máximo absoluto.
    for (const item of body.items ?? []) {
      if (!item.unitPrice || item.unitPrice <= 0) continue
      const gross      = item.quantity * item.unitPrice
      const discounted = (item.discount || 0) + (item.campaignDiscount || 0)
      const pct        = gross > 0 ? (discounted / gross) * 100 : 0
      if (pct > DISCOUNT.HARD_MAX_PCT) {
        return sendError(reply, `El descuento de "${item.productName || 'un ítem'}" supera el máximo permitido (${DISCOUNT.HARD_MAX_PCT}%)`)
      }
    }

    const tenantId = req.tenantId
    const userId   = req.user.id

    const sale = await prisma.$transaction(async (tx) => {

      // ── 1. Generar número de comprobante ─────────────────────────────────
      const tipo          = body.tipoComprobante || 'ticket'
      const invoiceNumber = await nextInvoiceNumber(tx, tenantId, tipo)

      // ── 2. Resolver cliente ──────────────────────────────────────────────
      const client = body.clientId
        ? await tx.client.findFirst({ where: { id: body.clientId, tenantId } })
        : null

      // ── 3. Expandir bundles y procesar stock ─────────────────────────────
      // Pre-fetch todos los productos no-bundle en una sola query
      const nonBundleIds = body.items
        .filter(i => !i.isBundle && i.stockControlUsed !== 'bundle' && i.type !== 'bundle')
        .map(i => i.productId)

      const productMap = new Map(
        (await tx.product.findMany({
          where:   { id: { in: nonBundleIds }, tenantId },
          include: { batches: true },
        })).map(p => [p.id, p])
      )

      const enrichedItems = []
      const saleMovements = []

      for (const item of body.items) {
        if (item.isBundle || item.stockControlUsed === 'bundle' || item.type === 'bundle') {
          enrichedItems.push({ ...item, batchAllocations: [], isBundle: true, stockControlUsed: 'bundle' })
          continue
        }

        const product = productMap.get(item.productId)
        if (!product) continue

        const { batchAllocations, stockControlUsed } = await allocateStock({
          product, item, invoiceNumber, userId,
        })

        saleMovements.push({
          tenantId,
          productId:     item.productId,
          productName:   item.productName || product.name,
          variantId:     item.variantId || null,
          type:          'salida',
          quantity:      item.quantity,
          previousStock: product.stock,
          newStock:      Math.max(0, product.stock - item.quantity),
          reason:        `Venta ${invoiceNumber}`,
          invoiceNumber,
          userId,
          unitPrice:     item.unitPrice || 0,
          totalSale:     HALF_UP((item.unitPrice || 0) * item.quantity),
        })

        enrichedItems.push({ ...item, batchAllocations, stockControlUsed })
      }

      if (saleMovements.length) await tx.stockMovement.createMany({ data: saleMovements })

      // ── 4. Crear la venta ────────────────────────────────────────────────
      const newSale = await tx.sale.create({
        data: {
          tenantId,
          invoiceNumber,
          tipoComprobante: tipo,
          clientId:        client?.id || null,
          clientName:      client?.name || body.clientName || '',
          clientDocument:  client ? `${client.documentType} ${client.documentNumber}` : (body.clientDocument || ''),
          userId,
          subtotal:        HALF_UP(body.subtotal ?? 0),
          discount:        HALF_UP(body.discount ?? 0),
          loyaltyDiscount: HALF_UP(body.loyaltyDiscount ?? 0),
          igvRate:         body.igvRate ?? 0.18,
          igv:             HALF_UP(body.igv ?? 0),
          total:           HALF_UP(body.total ?? 0),
          redeemedPoints:  body.redeemedPoints ?? 0,
          status:          'completada',
          sunatStatus:     tipo === 'ticket' ? 'no-aplica' : 'pendiente',
          items: {
            create: enrichedItems.map(item => ({
              productId:        item.productId,
              variantId:        item.variantId || null,
              productName:      item.productName || '',
              barcode:          item.barcode || '',
              quantity:         item.quantity,
              unitPrice:        item.unitPrice || 0,
              discount:         item.discount || 0,
              campaignDiscount: item.campaignDiscount || 0,
              totalDiscount:    item.totalDiscount || 0,
              netTotal:         item.netTotal || 0,
              unit:             item.unit || 'unidad',
              stockControlUsed: item.stockControlUsed || 'simple',
              isBundle:         item.isBundle || false,
              fromBundle:       item._fromBundle || '',
              bundleName:       item._bundleName || '',
              batchAllocations: item.batchAllocations?.length
                ? { create: item.batchAllocations.map(a => ({
                    batchId:     a.batchId     || '',
                    batchNumber: a.batchNumber || '',
                    quantity:    a.quantity,
                    expiryDate:  a.expiryDate  || '',
                  })) }
                : undefined,
            })),
          },
          payments: {
            create: (body.payments || []).map(p => ({
              method:    p.method,
              amount:    HALF_UP(p.amount),
              reference: p.reference || '',
            })),
          },
        },
        include: { items: { include: { batchAllocations: true } }, payments: true },
      })

      // ── 5. Vincular saleId a los seriales vendidos ───────────────────────
      // allocateStock marca el serial como 'vendido' pero sin saleId (aún no existía).
      // Ahora que tenemos newSale.id lo enlazamos.
      for (const ei of enrichedItems) {
        if (ei.stockControlUsed === 'serie' && ei.selectedSerial) {
          await tx.productSerial.updateMany({
            where: { tenantId, serialNumber: ei.selectedSerial, status: 'vendido' },
            data:  { saleId: newSale.id },
          })
        }
      }

      // ── 6. Deuda a crédito ───────────────────────────────────────────────
      if (client) {
        const creditPmt = body.payments?.find(p => p.method === 'credito')
        if (creditPmt) {
          await tx.client.update({
            where: { id: client.id },
            data:  { currentDebt: { increment: HALF_UP(creditPmt.amount) } },
          })
        }

        // ── 6. Puntos de lealtad ─────────────────────────────────────────
        const redeemedPoints  = Math.max(0, Math.floor(body.redeemedPoints || 0))
        const loyaltyDiscount = Math.max(0, Number(body.loyaltyDiscount || 0))
        const earned          = calcPointsEarned(newSale.total, client.loyaltyAccumulated || 0)

        const pointsAfterRedeem = Math.max(0, (client.loyaltyPoints || 0) - redeemedPoints)
        const pointsAfterEarn   = pointsAfterRedeem + (earned > 0 ? earned : 0)
        const newAccumulated    = (client.loyaltyAccumulated || 0) + Math.max(0, earned)

        const level = calcLoyaltyLevel(newAccumulated)

        const transactions = []
        if (redeemedPoints > 0) {
          transactions.push({
            clientId:     client.id,
            type:         'redeem',
            points:       -redeemedPoints,
            discount:     loyaltyDiscount,
            saleId:       newSale.id,
            invoiceNumber:newSale.invoiceNumber,
          })
        }
        if (earned > 0) {
          transactions.push({
            clientId:     client.id,
            type:         'earn',
            points:       earned,
            saleId:       newSale.id,
            invoiceNumber:newSale.invoiceNumber,
            saleTotal:    newSale.total,
            level,
          })
        }
        if (transactions.length) {
          await tx.loyaltyTransaction.createMany({ data: transactions })
        }

        await tx.client.update({
          where: { id: client.id },
          data:  { loyaltyPoints: pointsAfterEarn, loyaltyAccumulated: newAccumulated, loyaltyLevel: level },
        })
      }

      return newSale
    })

    return sendOk(reply, sale, null, 201)
  })

  // PATCH /api/sales/:id/cancel
  fastify.patch('/sales/:id/cancel', { preHandler: PRE }, async (req, reply) => {
    const schema = z.object({
      reason: z.string().min(1),
      userId: z.string().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Se requiere motivo de cancelación')

    const sale = await prisma.sale.findFirst({
      where:   { id: req.params.id, tenantId: req.tenantId },
      include: { items: { include: { batchAllocations: true } }, payments: true },
    })
    if (!sale) return send404(reply, 'Venta')
    if (sale.status !== 'completada') return send409(reply, 'Solo se pueden cancelar ventas completadas')

    await prisma.$transaction(async (tx) => {

      // ── 1. Restaurar stock ────────────────────────────────────────────────
      // Pre-fetch todos los productos no-bundle en una sola query
      const cancelItemIds = sale.items
        .filter(i => !i.isBundle && i.stockControlUsed !== 'bundle')
        .map(i => i.productId)

      const cancelProductMap = new Map(
        (await tx.product.findMany({
          where:   { id: { in: cancelItemIds } },
          include: { batches: true },
        })).map(p => [p.id, p])
      )

      const cancelMovements = []

      for (const item of sale.items) {
        if (item.isBundle || item.stockControlUsed === 'bundle') continue

        const product = cancelProductMap.get(item.productId)
        if (!product) continue

        await restoreStock({
          product,
          item: {
            variantId:        item.variantId,
            quantity:         item.quantity,
            stockControlUsed: item.stockControlUsed,
            batchAllocations: item.batchAllocations,
          },
        })

        cancelMovements.push({
          tenantId:      req.tenantId,
          productId:     item.productId,
          productName:   item.productName,
          variantId:     item.variantId || null,
          type:          'entrada',
          quantity:      item.quantity,
          previousStock: product.stock,
          newStock:      product.stock + item.quantity,
          reason:        `Cancelación ${sale.invoiceNumber}`,
          invoiceNumber: sale.invoiceNumber,
          userId:        req.user.id,
        })
      }

      if (cancelMovements.length) await tx.stockMovement.createMany({ data: cancelMovements })

      // ── 2. Revertir deuda a crédito ───────────────────────────────────────
      if (sale.clientId) {
        const creditPmt = sale.payments?.find(p => p.method === 'credito')
        if (creditPmt) {
          await tx.client.update({
            where: { id: sale.clientId },
            data:  { currentDebt: { decrement: HALF_UP(creditPmt.amount) } },
          })
        }
      }

      // ── 3. Revertir puntos de lealtad ─────────────────────────────────────
      // FIX: el bloque original no revertía puntos — creaba desincronía con el frontend
      if (sale.clientId) {
        const client = await tx.client.findUnique({ where: { id: sale.clientId } })
        if (client) {
          const loyaltyTxns = await tx.loyaltyTransaction.findMany({
            where: { saleId: sale.id },
          })
          const earned   = loyaltyTxns.filter(t => t.type === 'earn').reduce((s, t) => s + t.points, 0)
          const redeemed = loyaltyTxns.filter(t => t.type === 'redeem').reduce((s, t) => s + Math.abs(t.points), 0)

          const newPoints      = Math.max(0, (client.loyaltyPoints || 0) - earned + redeemed)
          const newAccumulated = Math.max(0, (client.loyaltyAccumulated || 0) - earned)
          const newLevel       = calcLoyaltyLevel(newAccumulated)

          await tx.client.update({
            where: { id: sale.clientId },
            data:  { loyaltyPoints: newPoints, loyaltyAccumulated: newAccumulated, loyaltyLevel: newLevel },
          })

          await tx.loyaltyTransaction.deleteMany({ where: { saleId: sale.id } })
        }
      }

      // ── 4. Generar NC si es boleta/factura ────────────────────────────────
      if (sale.tipoComprobante !== 'ticket') {
        const igvRate       = parseFloat(sale.igvRate ?? 0.18)
        const totalRefund   = sale.total
        const baseImponible = HALF_UP(totalRefund / (1 + igvRate))
        const igv           = HALF_UP(totalRefund - baseImponible)

        const ncNumber = await nextInvoiceNumber(tx, req.tenantId, 'nc')

        const billableItems = sale.items.filter(i => !i.fromBundle)

        await tx.return.create({
          data: {
            tenantId:        req.tenantId,
            ncNumber,
            saleId:          sale.id,
            invoiceNumber:   sale.invoiceNumber,
            tipoComprobante: 'nc',
            clientId:        sale.clientId || null,
            clientName:      sale.clientName || '',
            userId:          req.user.id,
            userName:        req.user.fullName || '',
            reason:          'anulacion',
            reasonLabel:     'Anulación de comprobante',
            reasonNote:      parsed.data.reason,
            totalRefund,
            baseImponible,
            igv,
            igvRate,
            status:          'completada',
            sunatStatus:     'pendiente',
            items: {
              create: billableItems.map(item => {
                const gross    = item.quantity * (item.unitPrice || 0)
                const discount = item.totalDiscount ?? ((item.discount || 0) + (item.campaignDiscount || 0))
                const netUnit  = item.netTotal != null && item.quantity > 0
                  ? HALF_UP(item.netTotal / item.quantity)
                  : HALF_UP(Math.max(0, gross - discount) / item.quantity)
                return {
                  saleItemId:   item.id,
                  productId:    item.productId,
                  productName:  item.productName,
                  barcode:      item.barcode || '',
                  quantity:     item.quantity,
                  unitPrice:    item.unitPrice || 0,
                  netUnitPrice: netUnit,
                  discount:     item.discount || 0,
                  totalRefund:  HALF_UP(netUnit * item.quantity),
                  unit:         item.unit || 'unidad',
                  batchId:      item.batchAllocations?.[0]?.batchId     || '',
                  batchNumber:  item.batchAllocations?.[0]?.batchNumber || '',
                  expiryDate:   item.batchAllocations?.[0]?.expiryDate  || '',
                }
              }),
            },
          },
        })
      }

      // ── 5. Marcar como cancelada ──────────────────────────────────────────
      await tx.sale.update({
        where: { id: sale.id },
        data:  { status: 'cancelada', cancelReason: parsed.data.reason, cancelledAt: new Date() },
      })
    })

    return sendOk(reply, { id: sale.id, status: 'cancelada' })
  })
}
