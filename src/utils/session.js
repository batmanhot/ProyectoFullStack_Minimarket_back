import { config } from '../config.js'

export const SESSION_COOKIE = 'mm_session'

const maxAgeSeconds = () => {
  const match = /^(\d+)([smhd])$/.exec(config.jwtExpiresIn)
  if (!match) return 8 * 60 * 60
  const value = Number(match[1])
  return value * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]] ?? 1)
}

export const getSessionToken = (request) => {
  const cookie = request.headers.cookie || ''
  const value = cookie.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`))
  if (value) return decodeURIComponent(value.slice(SESSION_COOKIE.length + 1))

  const authorization = request.headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null
}

export const setSessionCookie = (reply, token) => {
  const secure = config.nodeEnv === 'production' ? '; Secure' : ''
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds()}${secure}`,
  )
}

export const clearSessionCookie = (reply) => {
  const secure = config.nodeEnv === 'production' ? '; Secure' : ''
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`)
}
