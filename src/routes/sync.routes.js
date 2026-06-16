/**
 * sync.routes.js
 * Endpoint para sincronizar operaciones offline generadas mientras el POS
 * no tenía conexión a internet.
 *
 * POST /api/sync/pending-sales
 *   Recibe un array de operaciones en cola (sale.create, sale.cancel,
 *   cash.open, cash.close, return.create, return.anular) y las procesa
 *   en orden, devolviendo el resultado individual de cada una.
 *
 * La resolución de conflictos sigue estas reglas:
 *   - sale.create: si la venta ya existe (mismo id), se devuelve la existente sin error.
 *   - sale.cancel: si ya está cancelada, se devuelve OK sin re-cancelar.
 *   - cash.open:  si ya hay una sesión abierta, se devuelve la existente.
 *   - cash.close: si ya está cerrada, OK.
 *   - return.create: si el ncNumber ya existe, se devuelve la existente.
 *   - return.anular: si ya está anulada, OK.
 */
import prisma          from '../db.js'
import { requireAuth }   from '../middlewares/auth.js'
import { resolveTenant } from '../middlewares/tenant.js'
import { allocateStock, restoreStock, calcPointsEarned } from '../services/inventory.service.js'
import { nextInvoiceNumber } from '../utils/invoiceCounter.js'

const PRE     = [requireAuth, resolveTenant]
const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

export default async function syncRoutes(fastify) {

  // POST /api/sync/pending-sales
  fastify.post('/sync/pending-sales', { preHandler: PRE }, async (req, reply) => {
    const ops = req.body?.ops
    if (!Array.isArray(ops) || ops.length === 0) {
      return reply.code(400).send({ error: 'Se requiere un array "ops" con operaciones pendientes' })
    }

    const tenantId = req.tenantId
    const results  = []

    for (const op of ops) {
      const { id: opId, type, payload } = op

      try {
        switch (type) {

          // ── Crear venta ──────────────────────────────────────────────────
          case 'sale.create': {
            // Idempotencia: si la venta ya fue procesada (misma id), devolver la existente
            if (payload.id) {
              const existing = await prisma.sale.findFirst({
                where: { id: payload.id, tenantId },
                include: { items: { include: { batchAllocations: true } }, payments: true },
              })
              if (existing) {
                results.push({ opId, type, status: 'skipped', reason: 'already_exists', data: existing })
                continue
              }
            }

            const sale = await prisma.$transaction(async (tx) => {
              const tipo          = payload.tipoComprobante || 'ticket'
              const invoiceNumber = payload.invoiceNumber || await nextInvoiceNumber(tx, tenantId, tipo)
              const client        = payload.clientId
                ? await tx.client.findFirst({ where: { id: payload.clientId, tenantId } })
                : null

              const enrichedItems = []
              for (const item of payload.items || []) {
                if (item.isBundle || item.stockControlUsed === 'bundle') {
                  enrichedItems.push({ ...item, batchAllocations: [] })
                  continue
                }
                const product = await tx.product.findFirst({
                  where: { id: item.productId, tenantId }, include: { batches: true },
                })
                if (!product) continue
                const { batchAllocations, stockControlUsed } = await allocateStock({
                  product, item, invoiceNumber, userId: req.user.id,
                })
                await tx.stockMovement.create({
                  data: {
                    tenantId, productId: item.productId,
                    productName: item.productName || product.name,
                    variantId: item.variantId || null,
                    type: 'salida', quantity: item.quantity,
                    previousStock: product.stock,
                    newStock: Math.max(0, product.stock - item.quantity),
                    reason: `Venta offline ${invoiceNumber}`,
                    invoiceNumber, userId: req.user.id,
                  },
                })
                enrichedItems.push({ ...item, batchAllocations, stockControlUsed })
              }

              const newSale = await tx.sale.create({
                data: {
                  ...(payload.id && { id: payload.id }),
                  tenantId, invoiceNumber,
                  tipoComprobante: tipo,
                  clientId:        client?.id || null,
                  clientName:      client?.name || payload.clientName || '',
                  clientDocument:  client ? `${client.documentType} ${client.documentNumber}` : '',
                  userId:          req.user.id,
                  subtotal:        HALF_UP(payload.subtotal ?? 0),
                  discount:        HALF_UP(payload.discount ?? 0),
                  loyaltyDiscount: HALF_UP(payload.loyaltyDiscount ?? 0),
                  igvRate:         payload.igvRate ?? 0.18,
                  igv:             HALF_UP(payload.igv ?? 0),
                  total:           HALF_UP(payload.total ?? 0),
                  redeemedPoints:  payload.redeemedPoints ?? 0,
                  status:          'completada',
                  sunatStatus:     tipo === 'ticket' ? 'no-aplica' : 'pendiente',
                  createdAt:       payload.createdAt ? new Date(payload.createdAt) : new Date(),
                  items: {
                    create: enrichedItems.map(item => ({
                      productId: item.productId, variantId: item.variantId || null,
                      productName: item.productName || '', barcode: item.barcode || '',
                      quantity: item.quantity, unitPrice: item.unitPrice || 0,
                      discount: item.discount || 0, campaignDiscount: item.campaignDiscount || 0,
                      totalDiscount: item.totalDiscount || 0, netTotal: item.netTotal || 0,
                      unit: item.unit || 'unidad', stockControlUsed: item.stockControlUsed || 'simple',
                      isBundle: item.isBundle || false, fromBundle: item._fromBundle || '',
                      batchAllocations: item.batchAllocations?.length
                        ? { create: item.batchAllocations.map(a => ({
                            batchId: a.batchId, batchNumber: a.batchNumber || '',
                            quantity: a.quantity, expiryDate: a.expiryDate || '',
                          })) }
                        : undefined,
                    })),
                  },
                  payments: {
                    create: (payload.payments || []).map(p => ({
                      method: p.method, amount: HALF_UP(p.amount), reference: p.reference || '',
                    })),
                  },
                },
                include: { items: { include: { batchAllocations: true } }, payments: true },
              })

              if (client) {
                const creditPmt = payload.payments?.find(p => p.method === 'credito')
                if (creditPmt) {
                  await tx.client.update({
                    where: { id: client.id },
                    data:  { currentDebt: { increment: HALF_UP(creditPmt.amount) } },
                  })
                }
                const earned = calcPointsEarned(newSale.total, client.loyaltyAccumulated || 0)
                if (earned > 0) {
                  await tx.client.update({
                    where: { id: client.id },
                    data:  { loyaltyPoints: { increment: earned }, loyaltyAccumulated: { increment: earned } },
                  })
                }
              }

              return newSale
            })

            results.push({ opId, type, status: 'ok', data: sale })
            break
          }

          // ── Cancelar venta ────────────────────────────────────────────────
          case 'sale.cancel': {
            const sale = await prisma.sale.findFirst({
              where:   { id: payload.saleId, tenantId },
              include: { items: { include: { batchAllocations: true } }, payments: true },
            })
            if (!sale) { results.push({ opId, type, status: 'error', reason: 'not_found' }); continue }
            if (sale.status === 'cancelada') {
              results.push({ opId, type, status: 'skipped', reason: 'already_cancelled' }); continue
            }
            await prisma.$transaction(async (tx) => {
              for (const item of sale.items) {
                if (item.isBundle || item.stockControlUsed === 'bundle') continue
                const product = await tx.product.findFirst({ where: { id: item.productId }, include: { batches: true } })
                if (!product) continue
                await restoreStock({ product, item: { variantId: item.variantId, quantity: item.quantity, stockControlUsed: item.stockControlUsed, batchAllocations: item.batchAllocations } })
              }
              await tx.sale.update({
                where: { id: sale.id },
                data:  { status: 'cancelada', cancelReason: payload.reason || 'offline', cancelledAt: new Date() },
              })
            })
            results.push({ opId, type, status: 'ok', data: { id: sale.id, status: 'cancelada' } })
            break
          }

          // ── Apertura de caja ──────────────────────────────────────────────
          case 'cash.open': {
            const existing = await prisma.cashSession.findFirst({
              where: { tenantId, status: 'abierta' },
            })
            if (existing) {
              results.push({ opId, type, status: 'skipped', reason: 'already_open', data: existing }); continue
            }
            const session = await prisma.cashSession.create({
              data: {
                ...(payload.id && { id: payload.id }),
                tenantId, userId: req.user.id,
                status: 'abierta',
                openingAmount: payload.openingAmount || 0,
                openedAt: payload.openedAt ? new Date(payload.openedAt) : new Date(),
                notes: payload.notes || '',
              },
            })
            results.push({ opId, type, status: 'ok', data: session })
            break
          }

          // ── Cierre de caja ────────────────────────────────────────────────
          case 'cash.close': {
            const session = await prisma.cashSession.findFirst({
              where: { id: payload.sessionId || payload.id, tenantId },
            })
            if (!session) { results.push({ opId, type, status: 'error', reason: 'not_found' }); continue }
            if (session.status === 'cerrada') {
              results.push({ opId, type, status: 'skipped', reason: 'already_closed' }); continue
            }
            const closed = await prisma.cashSession.update({
              where: { id: session.id },
              data: {
                status:             'cerrada',
                closedAt:           payload.closedAt ? new Date(payload.closedAt) : new Date(),
                countedAmount:      payload.countedAmount || 0,
                expectedAmount:     payload.expectedAmount || 0,
                difference:         payload.difference || 0,
                salesCount:         payload.salesCount || 0,
                totalSales:         payload.totalSales || 0,
                totalDebtCollected: payload.totalDebtCollected || 0,
                debtPaymentsCount:  payload.debtPaymentsCount || 0,
                notes:              payload.notes || '',
              },
            })
            results.push({ opId, type, status: 'ok', data: closed })
            break
          }

          // ── Crear devolución ──────────────────────────────────────────────
          case 'return.create': {
            const ret = await prisma.return.create({
              data: {
                ...(payload.id && { id: payload.id }),
                tenantId,
                ncNumber:        payload.ncNumber || `NC-SYNC-${Date.now()}`,
                saleId:          payload.saleId || null,
                invoiceNumber:   payload.invoiceNumber || '',
                tipoComprobante: 'nc',
                clientId:        payload.clientId || null,
                clientName:      payload.clientName || '',
                userId:          req.user.id,
                userName:        req.user.fullName || '',
                reason:          payload.reason,
                reasonLabel:     payload.reasonLabel || payload.reason,
                reasonNote:      payload.reasonNote || '',
                totalRefund:     HALF_UP(payload.totalRefund || 0),
                baseImponible:   HALF_UP(payload.baseImponible || 0),
                igv:             HALF_UP(payload.igv || 0),
                igvRate:         payload.igvRate || 0.18,
                status:          'completada',
                sunatStatus:     'pendiente',
                createdAt:       payload.createdAt ? new Date(payload.createdAt) : new Date(),
                items: { create: (payload.items || []).map(i => ({ ...i })) },
              },
              include: { items: true },
            })
            results.push({ opId, type, status: 'ok', data: ret })
            break
          }

          // ── Anular devolución ─────────────────────────────────────────────
          case 'return.anular': {
            const ret = await prisma.return.findFirst({ where: { id: payload.returnId, tenantId } })
            if (!ret) { results.push({ opId, type, status: 'error', reason: 'not_found' }); continue }
            if (ret.status === 'anulada') { results.push({ opId, type, status: 'skipped', reason: 'already_anulada' }); continue }
            await prisma.return.update({
              where: { id: ret.id },
              data:  { status: 'anulada', anulatedAt: new Date(), anulationReason: payload.motivo || '' },
            })
            results.push({ opId, type, status: 'ok', data: { id: ret.id, status: 'anulada' } })
            break
          }

          default:
            results.push({ opId, type, status: 'error', reason: `Tipo de operación desconocido: ${type}` })
        }
      } catch (err) {
        fastify.log.error(err, `[sync] Error procesando op ${type} (opId=${opId})`)
        results.push({
          opId, type, status: 'error',
          reason: err.message || 'Error interno al procesar operación',
        })
      }
    }

    const summary = {
      total:   results.length,
      ok:      results.filter(r => r.status === 'ok').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      error:   results.filter(r => r.status === 'error').length,
    }

    return reply.send({ data: results, meta: summary })
  })
}
