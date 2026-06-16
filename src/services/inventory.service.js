// Lógica de descuento de stock replicando la estrategia del frontend:
// Simple · Lote FEFO · Lote FIFO · Número de serie · Variantes
// Retorna las actualizaciones a aplicar en la DB (no las aplica directamente).

import prisma from '../db.js'

const HALF_UP = (n) => Math.floor(Number(n) * 100 + 0.5) / 100

// ── Descuenta stock de un ítem y devuelve batch allocations ──────────────────
export async function allocateStock({ product, item, invoiceNumber, userId }) {
  const { stockControl, batches = [] } = product
  const qty = item.quantity

  // Variante con stock propio
  if (item.variantId) {
    const variant = await prisma.productVariant.findUnique({ where: { id: item.variantId } })
    if (variant) {
      const prev = variant.stock ?? 0
      const next = Math.max(0, prev - qty)
      await prisma.productVariant.update({ where: { id: variant.id }, data: { stock: next } })
      return { batchAllocations: [], stockControlUsed: 'simple', stockDelta: -qty }
    }
  }

  // Número de serie
  if (stockControl === 'serie') {
    const prev = product.stock
    await prisma.product.update({ where: { id: product.id }, data: { stock: Math.max(0, prev - qty) } })
    return { batchAllocations: [], stockControlUsed: 'serie', stockDelta: -qty }
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
      await prisma.productBatch.update({
        where: { id: batch.id },
        data:  { quantity: newQty, status: newQty <= 0 ? 'agotado' : batch.status },
      })
    }

    // Recalcular stock total del producto sumando lotes activos
    const updatedBatches = await prisma.productBatch.findMany({ where: { productId: product.id } })
    const newStock = updatedBatches
      .filter(b => b.status === 'activo')
      .reduce((s, b) => s + (b.quantity ?? 0), 0)
    await prisma.product.update({ where: { id: product.id }, data: { stock: newStock } })

    return { batchAllocations: allocations, stockControlUsed: stockControl, stockDelta: -(qty - remaining) }
  }

  // Simple
  const prev = product.stock
  const next = Math.max(0, prev - qty)
  await prisma.product.update({ where: { id: product.id }, data: { stock: next } })
  return { batchAllocations: [], stockControlUsed: 'simple', stockDelta: -qty }
}

// ── Restaura stock al cancelar una venta ─────────────────────────────────────
export async function restoreStock({ product, item }) {
  const { stockControl } = product
  const qty = item.quantity

  if (item.variantId) {
    const variant = await prisma.productVariant.findUnique({ where: { id: item.variantId } })
    if (variant) {
      await prisma.productVariant.update({
        where: { id: variant.id },
        data:  { stock: (variant.stock ?? 0) + qty },
      })
      return
    }
  }

  if ((stockControl === 'lote_fefo' || stockControl === 'lote_fifo') && item.batchAllocations?.length) {
    for (const alloc of item.batchAllocations) {
      const batch = await prisma.productBatch.findUnique({ where: { id: alloc.batchId } })
      if (!batch) continue
      const newQty = (batch.quantity ?? 0) + alloc.quantity
      await prisma.productBatch.update({
        where: { id: batch.id },
        data:  { quantity: newQty, status: newQty > 0 && batch.status === 'agotado' ? 'activo' : batch.status },
      })
    }
    const updatedBatches = await prisma.productBatch.findMany({ where: { productId: product.id } })
    const newStock = updatedBatches.filter(b => b.status === 'activo').reduce((s, b) => s + (b.quantity ?? 0), 0)
    await prisma.product.update({ where: { id: product.id }, data: { stock: newStock } })
    return
  }

  await prisma.product.update({
    where: { id: product.id },
    data:  { stock: (product.stock ?? 0) + qty },
  })
}

// ── Calcula puntos de lealtad ganados ────────────────────────────────────────
export function calcPointsEarned(total, accumulated) {
  const rate = accumulated >= 5000 ? 2 : accumulated >= 2000 ? 1.5 : 1
  return Math.floor((total / 10) * rate)
}
