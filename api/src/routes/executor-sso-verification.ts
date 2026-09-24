import type { FastifyInstance, FastifyReply } from 'fastify'
import { UoaOrgRequestRejectedError, UoaOrgRequestUnavailableError } from '@nessie/runtime'
import { ConfirmExecutorAccessChangeBodySchema } from '../contracts/executors.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { executorSsoVerification } from '../services/executor-sso-verification.js'
import { guardAuthRequest, rateLimitForRules } from './auth-rate-limit.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

export const sendExecutorSsoError = (reply: FastifyReply, error: unknown): boolean => {
  if (sendExecutorError(reply, error)) return true
  if (error instanceof UoaOrgRequestRejectedError) {
    const message = error.statusCode === 429 ? 'Too many attempts. Please wait before trying again.'
      : error.upstreamCode === 'TWOFA_ENROLLMENT_REQUIRED'
        ? 'Your organisation requires an authenticator. Set it up with your sign-in provider first.'
        : 'Verification failed or expired. Check the code, or send a new one.'
    sendApiError(reply, error.statusCode, 'EXECUTOR_VERIFICATION_FAILED', message)
    return true
  }
  if (error instanceof UoaOrgRequestUnavailableError) {
    sendApiError(reply, 503, 'EXECUTOR_VERIFICATION_UNAVAILABLE', 'Verification is temporarily unavailable. Try again shortly.')
    return true
  }
  return false
}

export const registerExecutorSsoVerificationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.post('/api/executor-access-changes/:accessChangeId/verification', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext || !deps.requireUserActor(actorContext, reply)) return reply
    const body = parseInput(
      ConfirmExecutorAccessChangeBodySchema.pick({ confirmationToken: true }), request.body, reply,
    )
    if (!body) return reply
    if (!await guardAuthRequest(deps.rateLimiter, rateLimitForRules(deps.config.api.rateLimit, 'stepUpIp'),
      request, reply, { account: rateLimitForRules(deps.config.api.rateLimit, 'stepUpAccount'),
        accountIdentity: actorContext.actor.actorId, auditContext: actorContext })) return reply
    const { accessChangeId } = request.params as { accessChangeId: string }
    try {
      return createApiResponse(await executorSsoVerification(deps.prisma, actorContext, { ...body, accessChangeId }))
    } catch (error) {
      if (sendExecutorSsoError(reply, error)) return reply
      throw error
    }
  })
}
