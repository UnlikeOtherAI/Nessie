import type { FastifyInstance } from 'fastify'

import { sendApiError } from './api.js'
import type { ServerContext } from './server-context.js'

type GlobalAuthHookDeps = Pick<
  ServerContext,
  'authenticateRequest' | 'checkRateLimit'
>

/**
 * Apply the API-wide rate-limit and authentication gate.
 *
 * Routes opt out of authentication only with Fastify's explicit
 * `config.public` metadata. This keeps every other route fail-closed by
 * default while allowing provider callbacks that authenticate through a
 * separate, route-specific mechanism.
 */
export const registerGlobalAuthHook = (
  app: FastifyInstance,
  { authenticateRequest, checkRateLimit }: GlobalAuthHookDeps,
): void => {
  app.addHook('preHandler', async (request, reply) => {
    const rateLimit = checkRateLimit(request)
    if (rateLimit) {
      reply.header('retry-after', String(rateLimit.retryAfterSeconds))
      sendApiError(reply, 429, 'RATE_LIMITED', 'Too many requests')
      return
    }

    if (request.routeOptions.config.public === true) {
      return
    }

    await authenticateRequest(request, reply)
  })
}
