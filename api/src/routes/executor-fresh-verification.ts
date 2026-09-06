import type { PrismaClient } from '@prisma/client'
import type { NessieConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { verifyPassword } from '../auth/password.js'
import { sendApiError } from '../lib/api.js'
import type { RateLimiter } from '../services/rate-limit.js'
import { guardAuthRequest, rateLimitForRules } from './auth-rate-limit.js'

/**
 * Step-up verification for an executor access change: a route guard, not a
 * service. It takes the request and the reply, rate-limits on the HTTP
 * identity and writes the 401/409 body itself, so it belongs beside the routes
 * it guards rather than in `services/`, where it was the package's only
 * upward import into `routes/`.
 */
export const requireFreshExecutorPasswordVerification = async (input: {
  actorContext: AuthorizedActionContext
  currentPassword: string | undefined
  rateLimit: NessieConfig['api']['rateLimit']
  rateLimiter: RateLimiter
  prisma: PrismaClient
  reply: FastifyReply
  request: FastifyRequest
}): Promise<boolean> => {
  if (
    !(await guardAuthRequest(
      input.rateLimiter,
      rateLimitForRules(input.rateLimit, 'stepUpIp'),
      input.request,
      input.reply,
      {
        account: rateLimitForRules(input.rateLimit, 'stepUpAccount'),
        accountIdentity: input.actorContext.actor.actorId,
        auditContext: input.actorContext,
      },
    ))
  ) return false
  const user = await input.prisma.user.findUnique({
    where: { id: input.actorContext.actor.actorId },
    select: { passwordHash: true },
  })
  if (!user?.passwordHash) {
    sendApiError(
      input.reply,
      409,
      'EXECUTOR_FRESH_VERIFICATION_UNAVAILABLE',
      'This account needs an SSO or WebAuthn verification factor before it can confirm this change.',
    )
    return false
  }
  if (!input.currentPassword || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    sendApiError(input.reply, 401, 'EXECUTOR_FRESH_VERIFICATION_REQUIRED', 'Current password verification failed')
    return false
  }
  return true
}
