/**
 * Tests: src/routes/auth.routes.js
 * Testea el endpoint POST /auth/login usando Fastify inject + prisma mock.
 *
 * NO requiere base de datos real — prisma está mockeado.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'

// ─── Mock de prisma ANTES de importar la ruta ─────────────────────────────────
vi.mock('../../db.js', () => ({
  default: {
    tenant: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    loginEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}))

// Mock de config para credenciales controladas
vi.mock('../../config.js', () => ({
  config: {
    superadminUser: 'superadmin',
    superadminPass: 'superadmin123',
    jwtSecret:      'test-secret-jwt',
    jwtExpiresIn:   '1h',
  },
}))

import authRoutes from '../../routes/auth.routes.js'
import prisma from '../../db.js'
import bcrypt from 'bcryptjs'

// ─── Setup del servidor de test ───────────────────────────────────────────────
let app

beforeAll(async () => {
  app = Fastify()
  await app.register(fastifyJwt, { secret: 'test-secret-jwt' })
  await app.register(authRoutes)
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /auth/login — validación de schema
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /auth/login — validación', () => {
  it('body vacío → 400 con mensaje de error', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toHaveProperty('error')
  })

  it('falta tenantSlug → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'alguien', password: 'clave' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('campos vacíos → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: '', password: '', tenantSlug: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /auth/login — superadmin
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /auth/login — superadmin', () => {
  it('credenciales correctas → 200 con token y user.role=superadmin', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'superadmin', password: 'superadmin123', tenantSlug: 'superadmin' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('token')
    expect(body.user.role).toBe('superadmin')
    expect(body.user.tenantId).toBeNull()
    expect(body.user.plan).toBe('enterprise')
  })

  it('password incorrecta → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'superadmin', password: 'wrong-pass', tenantSlug: 'superadmin' },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body)
    expect(body.error).toBeDefined()
    expect(body).not.toHaveProperty('token')
  })

  it('no toca prisma en el path superadmin', async () => {
    vi.clearAllMocks()
    await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'superadmin', password: 'superadmin123', tenantSlug: 'superadmin' },
    })
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled()
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('el token JWT decodificado contiene los campos correctos', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'superadmin', password: 'superadmin123', tenantSlug: 'superadmin' },
    })
    const { token } = JSON.parse(res.body)
    const decoded = app.jwt.decode(token)
    expect(decoded.role).toBe('superadmin')
    expect(decoded.id).toBe('superadmin')
    expect(decoded.tenantId).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /auth/login — usuario de tenant
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /auth/login — tenant user', () => {
  const mockTenant = {
    id:              'tenant-uuid-123',
    slug:            'bodega-test',
    businessName:    'Bodega Test',
    isActive:        true,
    accessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 días
    plan:            'basic',
  }

  it('tenant no encontrado → 401', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null)

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'cajero1', password: 'pass', tenantSlug: 'no-existe' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toContain('no encontrado')
  })

  it('tenant inactivo → 403', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ ...mockTenant, isActive: false })

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'cajero1', password: 'pass', tenantSlug: 'bodega-test' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('suspendido')
  })

  it('tenant con acceso vencido → 403', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      ...mockTenant,
      accessExpiresAt: new Date(Date.now() - 86400000), // ayer
    })

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'cajero1', password: 'pass', tenantSlug: 'bodega-test' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('vencido')
  })

  it('usuario no encontrado en el tenant → 401', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(mockTenant)
    prisma.user.findUnique.mockResolvedValueOnce(null)

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'no-existe', password: 'pass', tenantSlug: 'bodega-test' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('usuario inactivo → 403', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(mockTenant)
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1', username: 'admin', fullName: 'Admin', role: 'admin',
      isActive: false, passwordHash: 'hash',
    })

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'admin', password: 'pass', tenantSlug: 'bodega-test' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('desactivado')
  })

  it('password incorrecta → 401', async () => {
    const hash = await bcrypt.hash('correctpass', 10)
    prisma.tenant.findUnique.mockResolvedValueOnce(mockTenant)
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1', username: 'admin', fullName: 'Admin', role: 'admin',
      isActive: true, passwordHash: hash,
    })

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'admin', password: 'wrongpass', tenantSlug: 'bodega-test' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('login exitoso → 200 con token y datos del usuario', async () => {
    const hash = await bcrypt.hash('mipassword', 10)
    prisma.tenant.findUnique.mockResolvedValueOnce(mockTenant)
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-uuid-1', username: 'admin@bodega.pe', fullName: 'Administrador',
      role: 'admin', isActive: true, passwordHash: hash,
    })
    prisma.loginEvent.create.mockResolvedValueOnce({})

    const res = await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'admin@bodega.pe', password: 'mipassword', tenantSlug: 'bodega-test' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('token')
    expect(body.user.role).toBe('admin')
    expect(body.user.tenantId).toBe('tenant-uuid-123')
    expect(body.user.tenantSlug).toBe('bodega-test')
  })

  it('login exitoso registra loginEvent (fire-and-forget)', async () => {
    vi.clearAllMocks()
    const hash = await bcrypt.hash('pass123', 10)
    prisma.tenant.findUnique.mockResolvedValueOnce(mockTenant)
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-2', username: 'cajero1', fullName: 'Carlos Cajero',
      role: 'cajero', isActive: true, passwordHash: hash,
    })
    prisma.loginEvent.create.mockResolvedValueOnce({})

    await app.inject({
      method: 'POST',
      url:    '/auth/login',
      payload: { username: 'cajero1', password: 'pass123', tenantSlug: 'bodega-test' },
    })

    // Pequeña espera para que el fire-and-forget se ejecute
    await new Promise(r => setTimeout(r, 10))
    expect(prisma.loginEvent.create).toHaveBeenCalledOnce()
    expect(prisma.loginEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-uuid-123',
        username: 'cajero1',
        role:     'cajero',
      }),
    })
  })
})
