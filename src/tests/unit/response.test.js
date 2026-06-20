/**
 * Tests: src/utils/response.js
 * Verifica que los helpers HTTP generan el formato correcto.
 */
import { describe, it, expect, vi } from 'vitest'
import { sendOk, sendError, send404, send409 } from '../../utils/response.js'

// ─── Mock de reply ────────────────────────────────────────────────────────────
const makeReply = () => {
  const reply = {
    _code: 200,
    _body: null,
    code(n) { this._code = n; return this },
    send(body) { this._body = body; return this },
  }
  return reply
}

// ═══════════════════════════════════════════════════════════════════════════════
// sendOk
// ═══════════════════════════════════════════════════════════════════════════════
describe('sendOk', () => {
  it('respuesta 200 con data', () => {
    const reply = makeReply()
    sendOk(reply, { id: 1, name: 'Test' })
    expect(reply._code).toBe(200)
    expect(reply._body).toEqual({ data: { id: 1, name: 'Test' } })
  })

  it('incluye meta cuando se proporciona', () => {
    const reply = makeReply()
    sendOk(reply, [1, 2, 3], { total: 3 })
    expect(reply._body.meta).toEqual({ total: 3 })
  })

  it('sin meta → no incluye la clave meta', () => {
    const reply = makeReply()
    sendOk(reply, 'ok')
    expect(reply._body).not.toHaveProperty('meta')
  })

  it('acepta status personalizado (201 Created)', () => {
    const reply = makeReply()
    sendOk(reply, { created: true }, null, 201)
    expect(reply._code).toBe(201)
  })

  it('data puede ser null', () => {
    const reply = makeReply()
    sendOk(reply, null)
    expect(reply._body.data).toBeNull()
  })

  it('data puede ser array vacío', () => {
    const reply = makeReply()
    sendOk(reply, [])
    expect(reply._body.data).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// sendError
// ═══════════════════════════════════════════════════════════════════════════════
describe('sendError', () => {
  it('respuesta 400 por defecto con mensaje de error', () => {
    const reply = makeReply()
    sendError(reply, 'Datos inválidos')
    expect(reply._code).toBe(400)
    expect(reply._body).toEqual({ error: 'Datos inválidos' })
  })

  it('acepta status personalizado (401)', () => {
    const reply = makeReply()
    sendError(reply, 'No autorizado', 401)
    expect(reply._code).toBe(401)
    expect(reply._body.error).toBe('No autorizado')
  })

  it('acepta status 403', () => {
    const reply = makeReply()
    sendError(reply, 'Acceso suspendido', 403)
    expect(reply._code).toBe(403)
  })

  it('acepta status 500', () => {
    const reply = makeReply()
    sendError(reply, 'Error interno', 500)
    expect(reply._code).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// send404
// ═══════════════════════════════════════════════════════════════════════════════
describe('send404', () => {
  it('respuesta 404 con mensaje por defecto', () => {
    const reply = makeReply()
    send404(reply)
    expect(reply._code).toBe(404)
    expect(reply._body.error).toContain('no encontrado')
  })

  it('incluye el nombre de la entidad en el mensaje', () => {
    const reply = makeReply()
    send404(reply, 'Negocio')
    expect(reply._body.error).toContain('Negocio')
  })

  it('entidad personalizada: Producto', () => {
    const reply = makeReply()
    send404(reply, 'Producto')
    expect(reply._body.error).toBe('Producto no encontrado')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// send409
// ═══════════════════════════════════════════════════════════════════════════════
describe('send409', () => {
  it('respuesta 409 Conflict', () => {
    const reply = makeReply()
    send409(reply, 'El slug ya está en uso')
    expect(reply._code).toBe(409)
    expect(reply._body.error).toBe('El slug ya está en uso')
  })
})
