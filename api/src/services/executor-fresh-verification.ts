import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { verifyPassword } from '../auth/password.js'
import { sendApiError } from '../lib/api.js'
import type { RateLimiter } from './rate-limit.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from '../routes/auth-rate-limit.js'

export const requireFreshExecutorPasswordVerification = async (input: {
  actorContext: AuthorizedActionContext
  currentPassword: string | undefined
  rateLimit: { stepUpAccount: { max: number; windowMs: number }; stepUpIp: { max: number; windowMs: number } }
  rateLimiter: RateLimiter
  prisma: PrismaClient
  reply: FastifyReply
  request: FastifyRequest
}): Promise<boolean> => {
  if (
    !(await guardAuthRequest(
      input.rateLimiter,
      { bucket: RATE_LIMIT_BUCKETS.stepUpIp, rule: input.rateLimit.stepUpIp },
      input.request,
      input.reply,
      {
        account: {
          bucket: RATE_LIMIT_BUCKETS.stepUpAccount,
          rule: input.rateLimit.stepUpAccount,
        },
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
