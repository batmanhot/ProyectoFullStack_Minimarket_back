import { describe, expect, it, vi } from 'vitest'
import { allocateStock, lockProducts, restoreStock, StockInsufficientError } from '../../services/inventory.service.js'

describe('inventory.service transaction client', () => {
  it('locks each distinct product in a deterministic order', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) }

    await lockProducts(tx, 'tenant-1', ['product-b', 'product-a', 'product-b'])

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.$queryRaw.mock.calls.map(([, id]) => id)).toEqual(['product-a', 'product-b'])
  })

  it('uses the transaction supplied when allocating simple stock', async () => {
    const tx = {
      product: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      productVariant: {}, productSerial: {}, productBatch: {},
    }
    const result = await allocateStock({
      db: tx,
      product: { id: 'product-1', stock: 10, stockControl: 'simple' },
      item: { quantity: 3 },
      invoiceNumber: 'T001-1',
      userId: 'user-1',
    })

    expect(result.stockDelta).toBe(-3)
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'product-1', stock: { gte: 3 } },
      data: { stock: { decrement: 3 } },
    })
  })

  it('rejects a sale when the conditional stock update finds no available units', async () => {
    const tx = {
      product: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      productVariant: {}, productSerial: {}, productBatch: {},
    }

    await expect(allocateStock({
      db: tx,
      product: { id: 'product-1', name: 'Arroz', stock: 1, stockControl: 'simple' },
      item: { quantity: 2 },
      invoiceNumber: 'T001-1',
      userId: 'user-1',
    })).rejects.toBeInstanceOf(StockInsufficientError)
  })

  it('uses the transaction supplied when restoring simple stock', async () => {
    const tx = {
      product: { update: vi.fn().mockResolvedValue({}) },
      productVariant: {}, productSerial: {}, productBatch: {},
    }
    await restoreStock({
      db: tx,
      product: { id: 'product-1', stock: 7, stockControl: 'simple' },
      item: { quantity: 3 },
    })

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'product-1' }, data: { stock: 10 },
    })
  })
})
