/**
 * Helpers para respuestas HTTP consistentes en todos los endpoints.
 *
 * Formato de éxito:  { data: T, meta?: { total: number } }
 * Formato de error:  { error: string }
 *
 * Uso:
 *   return sendOk(reply, sale)
 *   return sendOk(reply, products, { total })
 *   return sendError(reply, 'Producto no encontrado', 404)
 */

export const sendOk = (reply, data, meta = null, status = 200) =>
  reply.code(status).send({ data, ...(meta && { meta }) })

export const sendError = (reply, message, status = 400) =>
  reply.code(status).send({ error: message })

export const send404 = (reply, entity = 'Recurso') =>
  sendError(reply, `${entity} no encontrado`, 404)

export const send409 = (reply, message) =>
  sendError(reply, message, 409)
