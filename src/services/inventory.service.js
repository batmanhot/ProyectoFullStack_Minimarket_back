// Lógica de descuento de stock replicando la estrategia del frontend:
// Simple · Lote FEFO · Lote FIFO · Número de serie · Variantes
// Retorna las actualizaciones a aplicar en la DB (no las aplica directamente).

import prisma from '../db.js'
import { LOYALTY } from '../config/businessRules.js'

const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

export class StockInsufficientError extends Error {
  constructor(productName = 'Producto') {
    super(`Stock insuficiente para ${productName}`)
    this.name = 'StockInsufficientError'
  }
}

/**
 * Locks product rows in a deterministic order. Every operation that reserves
 * or consumes stock uses this lock, preventing concurrent cash registers from
 * both validating the same units before either transaction writes them.
 */
export async function lockProducts(db, tenantId, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))].sort()
  for (const id of ids) {
    await db.$queryRaw`
      SELECT id FROM products
      WHERE id = ${id} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `
  }
}

// ── Descuenta stock de un ítem y devuelve batch allocations ──────────────────
export async function allocateStock({ product, item, invoiceNumber, userId, db = prisma }) {
  const { stockControl, batches = [] } = product
  const qty = item.quantity

  // Variante con stock propio
  if (item.variantId) {
    const updated = await db.productVariant.updateMany({
      where: { id: item.variantId, productId: product.id, stock: { gte: qty } },
      data:  { stock: { decrement: qty } },
    })
    if (updated.count !== 1) throw new StockInsufficientError(product.name)
    return { batchAllocations: [], stockControlUsed: 'simple', stockDelta: -qty }
  }

  // Número de serie
  if (stockControl === 'serie') {
    // Marcar el serial específico como vendido (sin saleId aún — se actualiza después de crear la venta)
    if (item.selectedSerial) {
      const updated = await db.productSerial.updateMany({
        where: { productId: product.id, serialNumber: item.selectedSerial, status: 'disponible' },
        data:  { status: 'vendido', invoiceNumber, soldAt: new Date() },
      })
      if (updated.count !== 1) throw new StockInsufficientError(product.name)
    } else {
      throw new StockInsufficientError(product.name)
    }
    // Stock = count de seriales disponibles (fuente de verdad)
    const disponibles = await db.productSerial.count({
      where: { productId: product.id, status: 'disponible' },
    })
    await db.product.update({ where: { id: product.id }, data: { stock: disponibles } })
    return {
      batchAllocations: item.selectedSerial ? [{ batchNumber: item.selectedSerial, quantity: 1 }] : [],
      stockControlUsed: 'serie',
      stockDelta: -qty,
    }
  }

  // Lote FEFO (First Expired First Out)
  if (stockControl === 'lote_fefo' || stockControl === 'lote_fifo') {
    const sorted = [...batches]
      .filter(b => b.status === 'activo' && (b.quantity ?? 0) > 0)
      .sort((a, b) => {
        if (stockControl === 'lote_fefo') {
          if (!a.expiryDate) return 1
          if (!b.expiryDate) return -1
          return new Date(a.expiryDate) - new Date(b.expiryDate)
        }
        return new Date(a.createdAt) - new Date(b.createdAt)
      })

    let remaining = qty
    const allocations = []

    for (const batch of sorted) {
      if (remaining <= 0) break
      const take = Math.min(remaining, batch.quantity)
      allocations.push({
        batchId:     batch.id,
        batchNumber: batch.number,
        quantity:    take,
        expiryDate:  batch.expiryDate ? new Date(batch.expiryDate).toISOString().slice(0, 10) : '',
      })
      remaining -= take

      const newQty = batch.quantity - take
      const updated = await db.productBatch.updateMany({
        where: { id: batch.id, status: 'activo', quantity: { gte: take } },
        data:  { quantity: newQty, status: newQty <= 0 ? 'agotado' : batch.status },
      })
      if (updated.count !== 1) throw new StockInsufficientError(product.name)
    }

    if (remaining > 0) throw new StockInsufficientError(product.name)

    // Recalcular stock total del producto sumando lotes activos
    const updatedBatches = await db.productBatch.findMany({ where: { productId: product.id } })
    const newStock = updatedBatches
      .filter(b => b.status === 'activo')
      .reduce((s, b) => s + (b.quantity ?? 0), 0)
    await db.product.update({ where: { id: product.id }, data: { stock: newStock } })

    return { batchAllocations: allocations, stockControlUsed: stockControl, stockDelta: -(qty - remaining) }
  }

  // Simple
  const updated = await db.product.updateMany({
    where: { id: product.id, stock: { gte: qty } },
    data:  { stock: { decrement: qty } },
  })
  if (updated.count !== 1) throw new StockInsufficientError(product.name)
  return { batchAllocations: [], stockControlUsed: 'simple', stockDelta: -qty }
}

// ── Restaura stock al cancelar una venta ─────────────────────────────────────
export async function restoreStock({ product, item, db = prisma }) {
  const { stockControl } = product
  const qty = item.quantity

  if (item.variantId) {
    const variant = await db.productVariant.findUnique({ where: { id: item.variantId } })
    if (variant) {
      await db.productVariant.update({
        where: { id: variant.id },
        data:  { stock: (variant.stock ?? 0) + qty },
      })
      return
    }
  }

  // Número de serie: restaurar el serial específico a disponible
  if (item.stockControlUsed === 'serie' && item.batchAllocations?.length) {
    const serialNumber = item.batchAllocations[0].batchNumber
    if (serialNumber) {
      await db.productSerial.updateMany({
        where: { productId: product.id, serialNumber },
        data:  { status: 'disponible', saleId: '', invoiceNumber: '', soldAt: null },
      })
    }
    const disponibles = await db.productSerial.count({
      where: { productId: product.id, status: 'disponible' },
    })
    await db.product.update({ where: { id: product.id }, data: { stock: disponibles } })
    return
  }

  if ((stockControl === 'lote_fefo' || stockControl === 'lote_fifo') && item.batchAllocations?.length) {
    for (const alloc of item.batchAllocations) {
      const batch = await db.productBatch.findUnique({ where: { id: alloc.batchId } })
      if (!batch) continue
      const newQty = (batch.quantity ?? 0) + alloc.quantity
      await db.productBatch.update({
        where: { id: batch.id },
        data:  { quantity: newQty, status: newQty > 0 && batch.status === 'agotado' ? 'activo' : batch.status },
      })
    }
    const updatedBatches = await db.productBatch.findMany({ where: { productId: product.id } })
    const newStock = updatedBatches.filter(b => b.status === 'activo').reduce((s, b) => s + (b.quantity ?? 0), 0)
    await db.product.update({ where: { id: product.id }, data: { stock: newStock } })
    return
  }

  await db.product.update({
    where: { id: product.id },
    data:  { stock: (product.stock ?? 0) + qty },
  })
}

// ── Calcula puntos de lealtad ganados ─────────────────────────────────────────
// Política: floor(total / POINTS_DIVISOR) × multiplicador por nivel.
// Los niveles y multiplicadores coinciden con LoyaltyEngine.js del frontend.
export function calcPointsEarned(total, accumulated) {
  const rate = accumulated >= LOYALTY.LEVEL_PLATINO ? LOYALTY.RATE_PLATINO
             : accumulated >= LOYALTY.LEVEL_ORO     ? LOYALTY.RATE_ORO
             : accumulated >= LOYALTY.LEVEL_PLATA   ? LOYALTY.RATE_PLATA
             : LOYALTY.RATE_BRONCE
  return Math.floor(Math.floor(total / LOYALTY.POINTS_DIVISOR) * rate)
}

// ── Calcula el nivel de lealtad según puntos acumulados históricos ────────────
export function calcLoyaltyLevel(accumulated) {
  if (accumulated >= LOYALTY.LEVEL_PLATINO) return LOYALTY.LEVELS.PLATINO
  if (accumulated >= LOYALTY.LEVEL_ORO)     return LOYALTY.LEVELS.ORO
  if (accumulated >= LOYALTY.LEVEL_PLATA)   return LOYALTY.LEVELS.PLATA
  return LOYALTY.LEVELS.BRONCE
}
