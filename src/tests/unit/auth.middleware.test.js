import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'

vi.mock('../../db.js', () => ({
  default: { user: { findUnique: vi.fn() } },
}))

import prisma from '../../db.js'
import { requireAuth } from '../../middlewares/auth.js'

let app

beforeAll(async () => {
  app = Fastify()
  await app.register(fastifyJwt, { secret: 'middleware-test-secret' })
  app.get('/protected', { preHandler: [requireAuth] }, async () => ({ ok: true }))
  await app.ready()
})

afterAll(async () => app.close())

const requestWithToken = (token) => app.inject({
  method: 'GET',
  url: '/protected',
  headers: { cookie: `mm_session=${encodeURIComponent(token)}` },
})

describe('requireAuth session revocation', () => {
  it('accepts an active user whose session version matches the JWT', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      tenantId: 'tenant-1', role: 'cajero', isActive: true, sessionVersion: 2,
    })
    const token = app.jwt.sign({ id: 'user-1', tenantId: 'tenant-1', role: 'cajero', sessionVersion: 2 })

    const response = await requestWithToken(token)
    expect(response.statusCode).toBe(200)
  })

  it('rejects a token after a password, role or account-state change', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      tenantId: 'tenant-1', role: 'cajero', isActive: false, sessionVersion: 3,
    })
    const token = app.jwt.sign({ id: 'user-1', tenantId: 'tenant-1', role: 'cajero', sessionVersion: 2 })

    const response = await requestWithToken(token)
    expect(response.statusCode).toBe(401)
  })
})
