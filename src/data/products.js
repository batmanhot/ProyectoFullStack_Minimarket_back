import { v4 as uuid } from 'uuid'

// Catálogo de productos mock para pruebas de integración
export const PRODUCTS = [
  {
    id: 'prod-001', name: 'Coca Cola 500ml', barcode: '7501055300006',
    sku: 'CCO-500', categoryId: 'cat-bebidas', description: 'Bebida gaseosa 500ml',
    stock: 120, stockMin: 10, unit: 'unidad', priceBuy: 1.50,
    price: 2.50, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-002', name: 'Agua San Luis 600ml', barcode: '7751007000017',
    sku: 'ASL-600', categoryId: 'cat-bebidas', description: 'Agua mineral 600ml',
    stock: 200, stockMin: 20, unit: 'unidad', priceBuy: 0.60,
    price: 1.00, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-003', name: 'Arroz Costeño 1kg', barcode: '7751234560001',
    sku: 'ARR-1KG', categoryId: 'cat-abarrotes', description: 'Arroz extra añejo 1kg',
    stock: 80, stockMin: 5, unit: 'kg', priceBuy: 3.20,
    price: 4.50, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-004', name: 'Aceite Primor 1L', barcode: '7750253200009',
    sku: 'ACE-1L', categoryId: 'cat-abarrotes', description: 'Aceite vegetal 1 litro',
    stock: 45, stockMin: 5, unit: 'unidad', priceBuy: 6.50,
    price: 8.90, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-005', name: 'Leche Gloria Evaporada 400g', barcode: '7750021300002',
    sku: 'LGL-400', categoryId: 'cat-lacteos', description: 'Leche evaporada entera 400g',
    stock: 150, stockMin: 15, unit: 'unidad', priceBuy: 3.10,
    price: 4.20, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-006', name: 'Pan de Molde Bimbo', barcode: '7501030440002',
    sku: 'PAN-MOL', categoryId: 'cat-panaderia', description: 'Pan de molde integral',
    stock: 30, stockMin: 5, unit: 'unidad', priceBuy: 5.50,
    price: 7.50, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-007', name: 'Azúcar Rubia 1kg', barcode: '7754321001001',
    sku: 'AZU-1KG', categoryId: 'cat-abarrotes', description: 'Azúcar rubia 1kg',
    stock: 60, stockMin: 5, unit: 'kg', priceBuy: 2.80,
    price: 3.80, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'prod-008', name: 'Fideos Don Vittorio 500g', barcode: '7754001020001',
    sku: 'FID-500', categoryId: 'cat-abarrotes', description: 'Fideos spaghetti 500g',
    stock: 90, stockMin: 10, unit: 'unidad', priceBuy: 2.20,
    price: 3.00, isActive: true, type: 'simple', stockControl: 'simple',
    expiryDate: null, batches: [], components: [], variantId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
]
