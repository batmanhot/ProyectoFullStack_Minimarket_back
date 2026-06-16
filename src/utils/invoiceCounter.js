// Genera el siguiente número de comprobante para un tenant de forma atómica.
// El upsert en PostgreSQL es atómico (INSERT ... ON CONFLICT DO UPDATE),
// garantizando que dos ventas simultáneas nunca obtengan el mismo número.

const PREFIX = {
  ticket:  'T001',
  boleta:  'B001',
  factura: 'F001',
  nc:      'NC001',
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} tenantId
 * @param {'ticket'|'boleta'|'factura'|'nc'} type
 * @returns {Promise<string>}  ej. "B001-000042"
 */
export async function nextInvoiceNumber(tx, tenantId, type) {
  const prefix = PREFIX[type] ?? 'T001'

  const counter = await tx.counter.upsert({
    where:  { tenantId_type: { tenantId, type } },
    create: { tenantId, type, current: 1 },
    update: { current: { increment: 1 } },
  })

  return `${prefix}-${String(counter.current).padStart(6, '0')}`
}
