import 'dotenv/config'
import pkg from '@prisma/client'

const { PrismaClient } = pkg
let prisma
const SOURCE_SLUG = 'demo'
const E2E_SLUG = 'e2e'

function requireE2EDatabaseUrl() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('El reinicio E2E está prohibido en producción.')
  }

  const databaseUrl = process.env.E2E_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('E2E_DATABASE_URL es obligatoria para reiniciar datos E2E.')
  }

  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('E2E_DATABASE_URL debe ser una URL PostgreSQL válida.')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !/e2e/i.test(parsed.pathname)) {
    throw new Error('E2E_DATABASE_URL debe apuntar a una base PostgreSQL exclusiva cuyo nombre incluya "e2e".')
  }

  return databaseUrl
}

const without = (record, keys) => Object.fromEntries(
  Object.entries(record).filter(([key]) => !keys.includes(key)),
)

/**
 * Algunas relaciones operativas conservan FK restrictivas hacia producto.
 * Se eliminan explícitamente, desde el detalle hacia la cabecera, antes de
 * borrar el tenant E2E. Así el reset sigue siendo repetible tras ventas,
 * devoluciones, compras o reservas creadas por una ejecución anterior.
 */
async function removeTenantOperationalData(tx, tenantId) {
  const saleWhere = { sale: { tenantId } }
  const purchaseWhere = { purchase: { tenantId } }
  const returnWhere = { return: { tenantId } }
  const reserveWhere = { reserve: { tenantId } }
  const productWhere = { product: { tenantId } }

  await tx.returnItem.deleteMany({ where: returnWhere })
  await tx.saleItemBatch.deleteMany({ where: { saleItem: saleWhere } })
  await tx.saleItem.deleteMany({ where: saleWhere })
  await tx.salePayment.deleteMany({ where: saleWhere })
  await tx.return.deleteMany({ where: { tenantId } })
  await tx.purchaseItem.deleteMany({ where: purchaseWhere })
  await tx.purchase.deleteMany({ where: { tenantId } })
  await tx.stockReserveItem.deleteMany({ where: reserveWhere })
  await tx.stockReserve.deleteMany({ where: { tenantId } })
  await tx.stockMovement.deleteMany({ where: { tenantId } })
  await tx.mermaRecord.deleteMany({ where: { tenantId } })
  await tx.stockTransfer.deleteMany({ where: { tenantId } })
  await tx.productLocation.deleteMany({ where: { tenantId } })
  await tx.productSerial.deleteMany({ where: { tenantId } })
  await tx.productBatch.deleteMany({ where: productWhere })
  await tx.productVariant.deleteMany({ where: productWhere })
  await tx.bundleComponent.deleteMany({
    where: { OR: [{ bundle: { tenantId } }, { product: { tenantId } }] },
  })
  await tx.cashSession.deleteMany({ where: { tenantId } })
  await tx.sale.deleteMany({ where: { tenantId } })
}

/**
 * Recrea un tenant exclusivo para Playwright a partir del catálogo demo.
 * Nunca modifica el tenant demo: únicamente elimina y vuelve a crear `e2e`.
 */
async function main() {
  // Nunca reutilizar DATABASE_URL: el reset solo puede operar sobre la base
  // explícitamente declarada para E2E.
  process.env.DATABASE_URL = requireE2EDatabaseUrl()
  prisma = new PrismaClient()

  const source = await prisma.tenant.findUnique({
    where: { slug: SOURCE_SLUG },
    include: {
      users: true,
      categories: true,
      brands: true,
      products: { include: { batches: true } },
      clients: true,
      suppliers: true,
    },
  })
  if (!source) throw new Error('No existe el tenant demo requerido como semilla E2E.')

  await prisma.$transaction(async (tx) => {
    const previous = await tx.tenant.findUnique({ where: { slug: E2E_SLUG } })
    if (previous) {
      await removeTenantOperationalData(tx, previous.id)
      await tx.tenant.delete({ where: { id: previous.id } })
    }

    const tenant = await tx.tenant.create({
      data: {
        // Las relaciones cargadas arriba sirven como origen, pero no forman
        // parte del modelo escalar de Tenant que Prisma puede crear.
        ...without(source, [
          'id', 'slug', 'createdAt', 'updatedAt',
          'users', 'categories', 'brands', 'products', 'clients', 'suppliers',
        ]),
        slug: E2E_SLUG,
        businessName: `${source.businessName} — E2E`,
        internalNotes: 'Tenant efímero exclusivo de Playwright. Se reinicia antes de cada suite.',
      },
    })

    if (source.users.length) {
      await tx.user.createMany({ data: source.users.map(user => ({
        ...without(user, ['id', 'tenantId', 'createdAt', 'updatedAt']), tenantId: tenant.id,
      })) })
    }
    if (source.categories.length) {
      await tx.category.createMany({ data: source.categories.map(category => ({
        ...without(category, ['id', 'tenantId', 'createdAt', 'updatedAt']), tenantId: tenant.id,
      })) })
    }
    if (source.brands.length) {
      await tx.brand.createMany({ data: source.brands.map(brand => ({
        ...without(brand, ['id', 'tenantId', 'createdAt', 'updatedAt']), tenantId: tenant.id,
      })) })
    }
    // No propagar datos que una ejecución histórica de Playwright hubiera
    // dejado accidentalmente en demo antes de que existiera este aislamiento.
    const sourceProducts = source.products.filter(product => !product.name.startsWith('Producto E2E '))
    if (sourceProducts.length) {
      for (const product of sourceProducts) {
        const created = await tx.product.create({
          data: { ...without(product, ['id', 'tenantId', 'batches', 'createdAt', 'updatedAt']), tenantId: tenant.id },
        })
        if (product.batches.length) {
          await tx.productBatch.createMany({ data: product.batches.map(batch => ({
            ...without(batch, ['id', 'productId', 'createdAt', 'updatedAt']), productId: created.id,
          })) })
        }
      }
    } else {
      throw new Error('La semilla E2E no contiene productos.')
    }
    if (source.clients.length) {
      await tx.client.createMany({ data: source.clients.map(client => ({
        ...without(client, ['id', 'tenantId', 'createdAt', 'updatedAt']), tenantId: tenant.id,
      })) })
    }
    if (source.suppliers.length) {
      await tx.supplier.createMany({ data: source.suppliers.map(supplier => ({
        ...without(supplier, ['id', 'tenantId', 'createdAt', 'updatedAt']), tenantId: tenant.id,
      })) })
    }
  })

  console.log(`Tenant E2E reiniciado desde ${SOURCE_SLUG}. El tenant demo no fue modificado.`)
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma?.$disconnect())
