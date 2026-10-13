import prisma from '../db.js'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1'])
const enabled = () => {
  const nodeEnv = process.env.NODE_ENV || 'development'
  const host = process.env.HOST || (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1')
  return nodeEnv === 'production' || !loopbackHosts.has(host)
}

const consume = async (key, max, windowMs) => {
  const now = new Date()
  const resetAt = new Date(now.getTime() + windowMs)
  let bucket = await prisma.rateLimitBucket.findUnique({ where: { key } })

  if (!bucket || bucket.resetAt <= now) {
    bucket = await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, resetAt },
      update: { count: 1, resetAt },
    })
  } else {
    bucket = await prisma.rateLimitBucket.update({
      where: { key },
      data: { count: { increment: 1 } },
    })
  }

  // Probabilistic cleanup avoids retaining expired buckets indefinitely while
  // keeping the hot path cheap across all application instances.
  if (Math.random() < 0.01) {
    prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lt: new Date(now.getTime() - 86_400_000) } },
    }).catch(() => {})
  }
  return bucket
}

export function publicRateLimit({ namespace, max, windowMs, key = () => '' }) {
  return async (request, reply) => {
    if (!enabled()) return

    const bucketKey = `${namespace}:${request.ip}:${key(request)}`
    const bucket = await consume(bucketKey, max, windowMs)
    if (bucket.count <= max) return

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000))
    reply.header('Retry-After', retryAfter)
    return reply.code(429).send({
      error: 'Demasiados intentos. Intenta nuevamente mas tarde.',
    })
  }
}

export const loginRateLimit = publicRateLimit({
  namespace: 'login',
  max: 10,
  windowMs: 15 * 60_000,
  key: (request) => String(request.body?.username || '').toLowerCase(),
})

export const registrationRateLimit = publicRateLimit({
  namespace: 'registration',
  max: 5,
  windowMs: 60 * 60_000,
})
