import type { FastifyRequest } from 'fastify'

type RateLimitRule = {
  keyPrefix: string
  max: number
  windowMs: number
}

type RateLimitBucket = {
  count: number
  resetAt: number
}

export const createFastifyTrustProxyConfig = (
  trustedProxyHops: number,
): false | number => trustedProxyHops > 0 ? trustedProxyHops : false

export const getRateLimitClientId = (
  request: Pick<FastifyRequest, 'ip'>,
): string => request.ip

const resolveRateLimitRule = (request: FastifyRequest): RateLimitRule | null => {
  const method = request.method.toUpperCase()
  const routePath = request.routeOptions.url
    ?? new URL(request.url, 'http://localhost').pathname

  if (
    method === 'POST'
    && (routePath === '/api/auth/session' || routePath === '/api/auth/bootstrap')
  ) {
    return {
      keyPrefix: `${method}:${routePath}`,
      max: 10,
      windowMs: 10 * 60 * 1_000,
    }
  }
  if (method === 'POST' && routePath === '/api/threads/:threadId/messages') {
    return { keyPrefix: `${method}:${routePath}`, max: 60, windowMs: 60_000 }
  }
  if (
    routePath.startsWith('/api/agents')
    && ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method)
  ) {
    return { keyPrefix: `${method}:${routePath}`, max: 60, windowMs: 60_000 }
  }
  return null
}

/** One in-process limiter; trusted proxy handling determines its client key. */
export const createRequestRateLimitChecker = () => {
  const buckets = new Map<string, RateLimitBucket>()
  return (request: FastifyRequest): { retryAfterSeconds: number } | null => {
    const rule = resolveRateLimitRule(request)
    if (!rule) return null

    const now = Date.now()
    const key = `${rule.keyPrefix}:${getRateLimitClientId(request)}`
    const existing = buckets.get(key)
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + rule.windowMs }
    bucket.count += 1
    buckets.set(key, bucket)
    if (bucket.count <= rule.max) return null
    return {
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1_000),
      ),
    }
  }
}
