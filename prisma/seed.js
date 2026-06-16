import 'dotenv/config'
import pkg        from '@prisma/client'
import bcrypt     from 'bcryptjs'

const { PrismaClient } = pkg
const prisma = new PrismaClient()

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const hash  = (p) => bcrypt.hash(p, 10)
const future = (days) => new Date(Date.now() + days * 86_400_000)

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n  🌱 Iniciando seed...\n')

  // ── 1. PlanConfig ──────────────────────────────────────────────────────────
  const plans = [
    {
      plan: 'trial',
      priceMonthly: 0, priceQuarterly: 0, priceSemiannual: 0, priceAnnual: 0,
      maxProducts: 50, maxUsers: 1, maxSalesPerDay: 30,
      hasSunat: false, hasMultiStore: false, hasReports: false,
      hasLoyalty: false, hasApiAccess: false,
    },
    {
      plan: 'basic',
      priceMonthly: 49, priceQuarterly: 129, priceSemiannual: 239, priceAnnual: 449,
      maxProducts: 500, maxUsers: 3, maxSalesPerDay: 200,
      hasSunat: true, hasMultiStore: false, hasReports: true,
      hasLoyalty: false, hasApiAccess: false,
    },
    {
      plan: 'pro',
      priceMonthly: 89, priceQuarterly: 239, priceSemiannual: 449, priceAnnual: 849,
      maxProducts: 2000, maxUsers: 10, maxSalesPerDay: 1000,
      hasSunat: true, hasMultiStore: true, hasReports: true,
      hasLoyalty: true, hasApiAccess: false,
    },
    {
      plan: 'enterprise',
      priceMonthly: 149, priceQuarterly: 399, priceSemiannual: 749, priceAnnual: 1399,
      maxProducts: 99999, maxUsers: 99999, maxSalesPerDay: 99999,
      hasSunat: true, hasMultiStore: true, hasReports: true,
      hasLoyalty: true, hasApiAccess: true,
    },
  ]

  for (const p of plans) {
    await prisma.planConfig.upsert({
      where:  { plan: p.plan },
      create: p,
      update: p,
    })
  }
  console.log('  ✓ PlanConfig — 4 planes creados (trial / basic / pro / enterprise)')

  // ── 2. SiteSettings ────────────────────────────────────────────────────────
  await prisma.siteSettings.upsert({
    where:  { id: 'singleton' },
    create: {
      id:              'singleton',
      heroTitle:       'Minimarket POS',
      heroSubtitle:    'Sistema de punto de venta para tu negocio',
      primaryColor:    '#f59e0b',
      logoUrl:         '',
      maintenanceMode: false,
    },
    update: {},
  })
  console.log('  ✓ SiteSettings — configurado')

  // ── 3. AlertThreshold ──────────────────────────────────────────────────────
  await prisma.alertThreshold.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', warning: 30, urgent: 7, critical: 1 },
    update: {},
  })
  console.log('  ✓ AlertThreshold — warning:30 / urgent:7 / critical:1 días')

  // ── 4. Tenant DEMO ─────────────────────────────────────────────────────────
  let tenant = await prisma.tenant.findUnique({ where: { slug: 'demo' } })

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        slug:               'demo',
        businessName:       'Minimarket La Esquina',
        sector:             'bodega',
        ruc:                '20123456789',
        ownerName:          'Juan Ponte',
        ownerEmail:         'admin@demo.com',
        phone:              '999-888-777',
        plan:               'pro',
        billingCycle:       'monthly',
        accessStartDate:    new Date(),
        accessExpiresAt:    future(365),
        registrationSource: 'superadmin',
        internalNotes:      'Tenant de prueba — generado por seed',
      },
    })
    console.log(`  ✓ Tenant creado  → slug: "demo"  (acceso hasta ${future(365).toLocaleDateString()})`)
  } else {
    // Extender acceso si ya existe
    await prisma.tenant.update({
      where: { id: tenant.id },
      data:  { accessExpiresAt: future(365), isActive: true },
    })
    console.log('  ✓ Tenant "demo" ya existe — acceso extendido 365 días')
  }

  // ── 5. Usuarios del tenant DEMO ────────────────────────────────────────────
  const users = [
    { fullName: 'Admin Demo',      username: 'admin@demo.com',  password: 'admin123',  role: 'admin'    },
    { fullName: 'Gerente Demo',    username: 'gerente',          password: 'gerente123', role: 'gerente'  },
    { fullName: 'Cajero Demo',     username: 'cajero',           password: 'cajero123', role: 'cajero'   },
  ]

  for (const u of users) {
    const exists = await prisma.user.findUnique({
      where: { tenantId_username: { tenantId: tenant.id, username: u.username } },
    })
    if (!exists) {
      await prisma.user.create({
        data: {
          tenantId:     tenant.id,
          fullName:     u.fullName,
          username:     u.username,
          passwordHash: await hash(u.password),
          role:         u.role,
          email:        u.username.includes('@') ? u.username : '',
        },
      })
      console.log(`  ✓ Usuario creado → ${u.username}  (pass: ${u.password}  rol: ${u.role})`)
    } else {
      console.log(`  · Usuario ya existe → ${u.username}`)
    }
  }

  // ── 6. Categorías del tenant DEMO ─────────────────────────────────────────
  const categorias = [
    { slug: 'abarrotes',        name: 'Abarrotes',         description: 'Productos de primera necesidad', color: '#f59e0b' },
    { slug: 'bebidas',          name: 'Bebidas',            description: 'Gaseosas, jugos y agua',         color: '#3b82f6' },
    { slug: 'lacteos',          name: 'Lácteos',            description: 'Leche, yogurt, queso',           color: '#8b5cf6' },
    { slug: 'limpieza',         name: 'Limpieza',           description: 'Productos de limpieza del hogar', color: '#06b6d4' },
    { slug: 'confiteria',       name: 'Confitería',         description: 'Dulces, golosinas y snacks',     color: '#ec4899' },
    { slug: 'panaderia',        name: 'Panadería',          description: 'Pan y productos horneados',      color: '#d97706' },
    { slug: 'higiene-personal', name: 'Higiene personal',   description: 'Jabón, shampoo y cuidado',       color: '#10b981' },
    { slug: 'ropa-accesorios',  name: 'Ropa y Accesorios',  description: 'Prendas de vestir y calzado',    color: '#6366f1' },
    { slug: 'electronica',      name: 'Electrónica',        description: 'Accesorios y gadgets',           color: '#64748b' },
    { slug: 'ferreteria',       name: 'Ferretería',         description: 'Herramientas y materiales',      color: '#78716c' },
  ]

  let catCreadas = 0
  for (const c of categorias) {
    await prisma.category.upsert({
      where:  { tenantId_slug: { tenantId: tenant.id, slug: c.slug } },
      create: { ...c, tenantId: tenant.id },
      update: { name: c.name, description: c.description, color: c.color },
    })
    catCreadas++
  }
  console.log(`  ✓ Categorías → ${catCreadas} creadas/actualizadas`)

  // ── 7. Marcas del tenant DEMO ──────────────────────────────────────────────
  const marcas = [
    { slug: 'alicorp',          name: 'Alicorp',          description: 'Corporación alimentaria peruana',    color: '#f97316' },
    { slug: 'gloria',           name: 'Gloria',           description: 'Lácteos y derivados',                color: '#3b82f6' },
    { slug: 'backus',           name: 'Backus',           description: 'Bebidas y gaseosas',                 color: '#f59e0b' },
    { slug: 'procter-gamble',   name: 'Procter & Gamble', description: 'Higiene y limpieza del hogar',       color: '#6366f1' },
    { slug: 'quaker',           name: 'Quaker',           description: 'Cereales y avenas',                  color: '#dc2626' },
    { slug: 'nestle',           name: 'Nestlé',           description: 'Alimentos y bebidas globales',       color: '#1d4ed8' },
    { slug: 'coca-cola',        name: 'Coca-Cola',        description: 'Bebidas carbonatadas y jugos',       color: '#dc2626' },
    { slug: 'colgate',          name: 'Colgate',          description: 'Higiene dental y personal',          color: '#dc2626' },
    { slug: 'ariel',            name: 'Ariel',            description: 'Detergentes y limpieza de ropa',     color: '#2563eb' },
    { slug: 'clorox',           name: 'Clorox',           description: 'Productos de desinfección',          color: '#fbbf24' },
    { slug: 'huggies',          name: 'Huggies',          description: 'Pañales y cuidado del bebé',         color: '#a78bfa' },
    { slug: 'don-vittorio',     name: 'Don Vittorio',     description: 'Pastas y fideos',                    color: '#f59e0b' },
    { slug: 'san-luis',         name: 'San Luis',         description: 'Agua mineral y bebidas',             color: '#06b6d4' },
    { slug: 'frugos',           name: 'Frugos',           description: 'Jugos y néctares',                   color: '#f97316' },
    { slug: 'lays',             name: 'Lays',             description: 'Papas fritas y snacks',              color: '#fbbf24' },
    { slug: 'basicos',          name: 'Básicos',          description: 'Productos genéricos y sin marca',    color: '#6b7280' },
  ]

  let marcaCreadas = 0
  for (const m of marcas) {
    await prisma.brand.upsert({
      where:  { tenantId_slug: { tenantId: tenant.id, slug: m.slug } },
      create: { ...m, tenantId: tenant.id },
      update: { name: m.name, description: m.description, color: m.color },
    })
    marcaCreadas++
  }
  console.log(`  ✓ Marcas → ${marcaCreadas} creadas/actualizadas`)

  // ── 9. Productos de muestra ────────────────────────────────────────────────
  const productos = [
    {
      name: 'Agua Mineral 500ml',     barcode: '7750075000001', sku: 'AGU-500',
      priceSell: 1.50, priceBuy: 0.80, stock: 120, stockMin: 24,
      unit: 'unidad', stockControl: 'simple', categoryId: 'bebidas',
    },
    {
      name: 'Coca Cola 1.5L',         barcode: '7750075000002', sku: 'COC-150',
      priceSell: 5.00, priceBuy: 3.20, stock: 48, stockMin: 12,
      unit: 'unidad', stockControl: 'simple', categoryId: 'bebidas',
    },
    {
      name: 'Arroz Extra 1kg',         barcode: '7750075000003', sku: 'ARR-1KG',
      priceSell: 4.50, priceBuy: 3.00, stock: 80, stockMin: 20,
      unit: 'kg', stockControl: 'simple', categoryId: 'abarrotes',
    },
    {
      name: 'Aceite Vegetal 1L',        barcode: '7750075000004', sku: 'ACE-1L',
      priceSell: 8.90, priceBuy: 6.50, stock: 36, stockMin: 6,
      unit: 'unidad', stockControl: 'simple', categoryId: 'abarrotes',
    },
    {
      name: 'Leche Gloria 400g',        barcode: '7750075000005', sku: 'LEG-400',
      priceSell: 4.20, priceBuy: 3.10, stock: 60, stockMin: 12,
      unit: 'unidad', stockControl: 'simple', categoryId: 'lacteos',
    },
    {
      name: 'Pan de Molde Bimbo',       barcode: '7750075000006', sku: 'PAN-BIM',
      priceSell: 6.50, priceBuy: 4.80, stock: 18, stockMin: 6,
      unit: 'unidad', stockControl: 'simple', categoryId: 'panaderia',
    },
    {
      name: 'Detergente Ariel 500g',    barcode: '7750075000007', sku: 'DET-ARI',
      priceSell: 9.90, priceBuy: 7.20, stock: 24, stockMin: 6,
      unit: 'unidad', stockControl: 'simple', categoryId: 'limpieza',
    },
    {
      name: 'Yogurt Gloria Fresa 1L',   barcode: '7750075000008', sku: 'YOG-FRE',
      priceSell: 7.50, priceBuy: 5.50, stock: 20, stockMin: 4,
      unit: 'unidad', stockControl: 'lote_fefo', categoryId: 'lacteos',
    },
    {
      name: 'Snickers 50g',             barcode: '7750075000009', sku: 'SNI-50',
      priceSell: 2.50, priceBuy: 1.60, stock: 0, stockMin: 10,
      unit: 'unidad', stockControl: 'simple', categoryId: 'confiteria',
    },
    {
      name: 'Papel Higiénico Suave x4', barcode: '7750075000010', sku: 'PAP-SUV',
      priceSell: 8.00, priceBuy: 5.80, stock: 30, stockMin: 6,
      unit: 'paquete', stockControl: 'simple', categoryId: 'limpieza',
    },
  ]

  let prodCreados = 0
  for (const p of productos) {
    const exists = await prisma.product.findUnique({
      where: { tenantId_barcode: { tenantId: tenant.id, barcode: p.barcode } },
    })
    if (!exists) {
      const prod = await prisma.product.create({
        data: { ...p, tenantId: tenant.id, margin: Math.round((p.priceSell - p.priceBuy) / p.priceBuy * 100) },
      })
      // Agregar lote para el yogurt (FEFO)
      if (prod.stockControl === 'lote_fefo') {
        await prisma.productBatch.create({
          data: {
            productId: prod.id,
            number:    'LOTE-001',
            quantity:  20,
            expiryDate: future(30),
            status:    'activo',
          },
        })
      }
      prodCreados++
    }
  }
  console.log(`  ✓ Productos creados → ${prodCreados} de ${productos.length} (los restantes ya existían)`)

  // ── 7. Cliente de muestra ──────────────────────────────────────────────────
  const clienteExists = await prisma.client.findUnique({
    where: { tenantId_documentNumber: { tenantId: tenant.id, documentNumber: '12345678' } },
  })
  if (!clienteExists) {
    await prisma.client.create({
      data: {
        tenantId:       tenant.id,
        name:           'María García López',
        documentType:   'DNI',
        documentNumber: '12345678',
        email:          'maria@example.com',
        phone:          '987654321',
        address:        'Av. Los Olivos 123, Lima',
        loyaltyPoints:  150,
        loyaltyAccumulated: 350.00,
        loyaltyLevel:   'plata',
      },
    })
    console.log('  ✓ Cliente demo creado → María García (DNI 12345678)')
  } else {
    console.log('  · Cliente demo ya existe')
  }

  // ── 8. Proveedor de muestra ────────────────────────────────────────────────
  const provExists = await prisma.supplier.findFirst({
    where: { tenantId: tenant.id, ruc: '20987654321' },
  })
  if (!provExists) {
    await prisma.supplier.create({
      data: {
        tenantId:      tenant.id,
        name:          'Distribuidora El Sol S.A.C.',
        contactPerson: 'Pedro Ramirez',
        email:         'ventas@elsol.com',
        phone:         '01-234-5678',
        address:       'Calle Comercio 456, Lima',
        ruc:           '20987654321',
      },
    })
    console.log('  ✓ Proveedor demo creado → Distribuidora El Sol S.A.C.')
  } else {
    console.log('  · Proveedor demo ya existe')
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n  ✅ Seed completado\n')
  console.log('  ┌─────────────────────────────────────────────────┐')
  console.log('  │  Credenciales para probar el sistema            │')
  console.log('  │                                                 │')
  console.log('  │  Superadmin (sin tenant):                       │')
  console.log('  │    usuario:  superadmin                         │')
  console.log('  │    password: superadmin123                      │')
  console.log('  │                                                 │')
  console.log('  │  Tenant demo  →  slug: "demo"                   │')
  console.log('  │    admin@demo.com  /  admin123    (admin)        │')
  console.log('  │    gerente         /  gerente123  (gerente)      │')
  console.log('  │    cajero          /  cajero123   (cajero)       │')
  console.log('  └─────────────────────────────────────────────────┘\n')
}

main()
  .catch((e) => { console.error('  ❌ Error en seed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
