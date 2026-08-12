import {
  confirmExecutorAccessChange,
  confirmExecutorEnrollment,
  claimExecutorConnection,
  createExecutor,
  ExecutorError,
  getExecutorAccessChangeForUser,
  getExecutorAccessView,
  getExecutorForUser,
  getPendingExecutorEnrollment,
  listVisibleExecutors,
  prepareExecutorAccessChange,
  rejectExecutorAccessChange,
  recordExecutorDaemonChallenge,
  reportExecutorHeartbeat,
  submitExecutorDescriptor,
  submitExecutorEnrollment,
  reviewExecutorDescriptor,
} from '@nessie/executor-manage'
import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  ConfirmExecutorAccessChangeBodySchema,
  ConfirmExecutorEnrollmentBodySchema,
  CreateExecutorBodySchema,
  CreateExecutorResponseSchema,
  ExecutorDaemonChallengeBodySchema,
  ExecutorDaemonChallengeSchema,
  ExecutorDaemonClaimBodySchema,
  ExecutorDaemonConnectionSchema,
  ExecutorDaemonDescriptorBodySchema,
  ExecutorDaemonDescriptorSchema,
  ExecutorDaemonHeartbeatBodySchema,
  ExecutorAccessChangeRecordSchema,
  ExecutorAccessViewSchema,
  ExecutorRecordSchema,
  PendingExecutorEnrollmentSchema,
  PrepareExecutorAccessChangeBodySchema,
  PreparedExecutorAccessChangeSchema,
  ReviewExecutorDescriptorBodySchema,
  SubmitExecutorEnrollmentBodySchema,
} from '../contracts.js'
import { verifyPassword } from '../auth/password.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  issueExecutorDaemonChallenge,
  verifyExecutorDaemonChallenge,
} from '../services/executor-daemon-auth.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import type { RouteDeps } from './types.js'

const sendExecutorError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof ExecutorError)) return false
  const status = error.code === 'EXECUTOR_NOT_FOUND'
    || error.code === 'EXECUTOR_ACCESS_CHANGE_NOT_FOUND'
    ? 404
    : error.code === 'SCOPE_ENTITLEMENT_DENIED'
      ? 403
      : error.code === 'EXECUTOR_DAEMON_PROOF_INVALID'
          || error.code === 'EXECUTOR_DAEMON_CHALLENGE_INVALID'
        ? 401
      : error.code === 'EXECUTOR_FRESH_VERIFICATION_REQUIRED'
        ? 401
      : error.code === 'EXECUTOR_STATE_TRANSITION_INVALID'
          || error.code === 'EXECUTOR_PRIVATE_FINAL_ADMIN_REQUIRED'
          || error.code === 'EXECUTOR_ACCESS_CHANGE_STALE'
          || error.code === 'EXECUTOR_ACCESS_CHANGE_EXPIRED'
          || error.code === 'EXECUTOR_CONNECTION_FENCED'
          || error.code === 'EXECUTOR_HEARTBEAT_STALE'
          || error.code === 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT'
          || error.code === 'EXECUTOR_DESCRIPTOR_ROLLBACK'
        ? 409
        : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}

/**
 * Human executor management and the deliberately narrow public enrollment
 * handoff. The daemon receives no ambient user session: it proves possession
 * of the one-time pairing challenge plus its Ed25519 machine key.
 */
export const registerExecutorRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config, prisma, rateLimiter, requireActorContext } = deps

  app.get('/api/executors', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const executors = await listVisibleExecutors(prisma, actorContext)
    return createApiResponse(ExecutorRecordSchema.array().parse(executors))
  })

  app.post('/api/executors', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateExecutorBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const created = await createExecutor(prisma, actorContext, body)
      return reply.code(201).send(createApiResponse(CreateExecutorResponseSchema.parse(created)))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/executor-access-changes/:accessChangeId/reject', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ConfirmExecutorAccessChangeBodySchema, request.body, reply)
    if (!body) return reply
    const { accessChangeId } = request.params as { accessChangeId: string }
    try {
      const result = await rejectExecutorAccessChange(prisma, actorContext, {
        accessChangeId,
        confirmationToken: body.confirmationToken,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'executor.access_change.rejected',
        resourceType: 'executor_access_change',
        resourceId: accessChangeId,
        outcome: 'success',
        metadata: { executorId: result.executorId },
      })
      return createApiResponse({ rejected: true })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/executors/:executorId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const found = await getExecutorForUser(prisma, actorContext, executorId)
    if (!found) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor not found')
      return reply
    }
    return createApiResponse(ExecutorRecordSchema.parse(found.executor))
  })

  app.get('/api/executors/:executorId/access', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const access = await getExecutorAccessView(prisma, actorContext, executorId)
    if (!access) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor not found')
      return reply
    }
    return createApiResponse(ExecutorAccessViewSchema.parse(access))
  })

  app.get('/api/executors/:executorId/pairing-pending', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const pending = await getPendingExecutorEnrollment(prisma, actorContext, executorId)
    if (!pending) {
      sendApiError(reply, 404, 'EXECUTOR_ENROLLMENT_NOT_FOUND', 'No pending enrollment found')
      return reply
    }
    return createApiResponse(PendingExecutorEnrollmentSchema.parse(pending))
  })

  app.post('/api/executors/:executorId/pairing-confirm', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const body = parseInput(ConfirmExecutorEnrollmentBodySchema, request.body, reply)
    if (!body) return reply
    try {
      await confirmExecutorEnrollment(prisma, actorContext, { executorId, ...body })
      return createApiResponse({ confirmed: true })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/executor-access-changes', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(PrepareExecutorAccessChangeBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const prepared = await prepareExecutorAccessChange(prisma, actorContext, body)
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'executor.access_change.prepared',
        resourceType: 'executor_access_change',
        resourceId: prepared.accessChangeId,
        outcome: 'success',
        metadata: {
          executorId: prepared.executorId,
          requiresFreshVerification: prepared.requiresFreshVerification,
        },
      })
      return createApiResponse(PreparedExecutorAccessChangeSchema.parse({
        ...prepared,
        expiresAt: prepared.expiresAt.toISOString(),
      }))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/executor-access-changes/:accessChangeId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { accessChangeId } = request.params as { accessChangeId: string }
    const found = await getExecutorAccessChangeForUser(prisma, actorContext, accessChangeId)
    if (!found) {
      sendApiError(reply, 404, 'EXECUTOR_ACCESS_CHANGE_NOT_FOUND', 'Access change not found')
      return reply
    }
    return createApiResponse(ExecutorAccessChangeRecordSchema.parse({
      ...found,
      expiresAt: found.expiresAt.toISOString(),
    }))
  })

  app.post('/api/executor-access-changes/:accessChangeId/confirm', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ConfirmExecutorAccessChangeBodySchema, request.body, reply)
    if (!body) return reply
    const { accessChangeId } = request.params as { accessChangeId: string }
    const accessChange = await getExecutorAccessChangeForUser(prisma, actorContext, accessChangeId)
    if (!accessChange) {
      sendApiError(reply, 404, 'EXECUTOR_ACCESS_CHANGE_NOT_FOUND', 'Access change not found')
      return reply
    }
    let freshVerificationSatisfied = false
    if (accessChange.requiresFreshVerification) {
      if (
        !(await guardAuthRequest(
          rateLimiter,
          { bucket: RATE_LIMIT_BUCKETS.stepUpIp, rule: config.api.rateLimit.stepUpIp },
          request,
          reply,
          {
            account: {
              bucket: RATE_LIMIT_BUCKETS.stepUpAccount,
              rule: config.api.rateLimit.stepUpAccount,
            },
            accountIdentity: actorContext.actor.actorId,
            auditContext: actorContext,
          },
        ))
      ) {
        return reply
      }
      const user = await prisma.user.findUnique({
        where: { id: actorContext.actor.actorId },
        select: { passwordHash: true },
      })
      if (!user?.passwordHash) {
        sendApiError(
          reply,
          409,
          'EXECUTOR_FRESH_VERIFICATION_UNAVAILABLE',
          'This account needs an SSO or WebAuthn verification factor before it can confirm this change.',
        )
        return reply
      }
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
        sendApiError(reply, 401, 'EXECUTOR_FRESH_VERIFICATION_REQUIRED', 'Current password verification failed')
        return reply
      }
      freshVerificationSatisfied = true
    }
    try {
      const result = await confirmExecutorAccessChange(prisma, actorContext, {
        accessChangeId,
        confirmationToken: body.confirmationToken,
        freshVerificationSatisfied,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'executor.access_change.confirmed',
        resourceType: 'executor_access_change',
        resourceId: accessChangeId,
        outcome: 'success',
        metadata: { executorId: result.executorId },
      })
      return createApiResponse(result)
    } catch (error) {
      if (error instanceof ExecutorError && error.code === 'EXECUTOR_ACCESS_CHANGE_EXPIRED') {
        await emitAuditEvent(prisma, {
          actorContext,
          action: 'executor.access_change.expired',
          resourceType: 'executor_access_change',
          resourceId: accessChangeId,
          outcome: 'denied',
        })
      }
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.put('/api/executors/:executorId/descriptor-review', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const body = parseInput(ReviewExecutorDescriptorBodySchema, request.body, reply)
    if (!body) return reply
    try {
      await reviewExecutorDescriptor(prisma, actorContext, { executorId, ...body })
      return createApiResponse({ reviewed: true })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post(
    '/api/executor-daemon/challenge',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonChallengeBodySchema, request.body, reply)
      if (!body) return reply
      if (!(await guardAuthRequest(
        rateLimiter,
        { bucket: RATE_LIMIT_BUCKETS.executorDaemonIp, rule: config.api.rateLimit.executorDaemonIp },
        request,
        reply,
      ))) return reply
      const challenge = issueExecutorDaemonChallenge(body.executorId, deps.authSecret)
      await recordExecutorDaemonChallenge(prisma, {
        challenge: challenge.challenge,
        executorId: body.executorId,
        expiresAt: new Date(challenge.expiresAt),
      })
      return createApiResponse(ExecutorDaemonChallengeSchema.parse(challenge))
    },
  )

  app.post(
    '/api/executor-daemon/claim',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonClaimBodySchema, request.body, reply)
      if (!body) return reply
      if (!verifyExecutorDaemonChallenge(body.challenge, body.executorId, deps.authSecret)) {
        sendApiError(reply, 401, 'EXECUTOR_DAEMON_CHALLENGE_INVALID', 'Executor challenge is invalid.')
        return reply
      }
      try {
        const connection = await claimExecutorConnection(prisma, body)
        return createApiResponse(ExecutorDaemonConnectionSchema.parse(connection))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/heartbeat',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonHeartbeatBodySchema, request.body, reply)
      if (!body) return reply
      try {
        const connection = await reportExecutorHeartbeat(prisma, body)
        return createApiResponse(ExecutorDaemonConnectionSchema.parse(connection))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/descriptor',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonDescriptorBodySchema, request.body, reply)
      if (!body) return reply
      try {
        const result = await submitExecutorDescriptor(prisma, body)
        return createApiResponse(ExecutorDaemonDescriptorSchema.parse(result))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-enrollments/submit',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(SubmitExecutorEnrollmentBodySchema, request.body, reply)
      if (!body) return reply
      try {
        await submitExecutorEnrollment(prisma, body)
        return createApiResponse({ accepted: true })
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )
}
