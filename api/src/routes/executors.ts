import {
  confirmExecutorAccessChange,
  confirmExecutorEnrollment,
  claimExecutorConnection,
  authorizeExecutorDaemonControlCall,
  bindExecutorCandidate,
  createExecutor,
  ensureExecutorLogicalTools,
  ExecutorError,
  getExecutorAccessChangeForUser,
  getExecutorAccessView,
  getExecutorForUser,
  listExecutorWorkspaceReviews,
  getPendingExecutorEnrollment,
  listVisibleExecutors,
  prepareExecutorAccessChange,
  rejectExecutorAccessChange,
  recordExecutorDaemonChallenge,
  pollExecutorCommand,
  recordExecutorCommandReceipt,
  resolveExecutorAvailabilityCandidates,
  reportExecutorHeartbeat,
  submitExecutorDescriptor,
  submitExecutorEnrollment,
} from '@nessie/executor-manage'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { ExecutorOperationKeySchema, parseChannelId, parseUserId } from '@nessie/schemas'

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
  ExecutorDaemonCommandPollBodySchema,
  ExecutorDaemonCommandPollSchema,
  ExecutorDaemonCommandReceiptBodySchema,
  ExecutorDaemonHeartbeatBodySchema,
  ExecutorAccessChangeRecordSchema,
  ExecutorAccessViewSchema,
  ExecutorAvailabilityRequestBodySchema,
  ExecutorAvailabilityResponseSchema,
  ExecutorRecordSchema,
  ExecutorRunBindBodySchema,
  ExecutorRunBindSchema,
  ExecutorRunLaunchBodySchema,
  ExecutorRunLaunchSchema,
  ExecutorWorkspaceReviewRecordSchema,
  PendingExecutorEnrollmentSchema,
  PrepareExecutorAccessChangeBodySchema,
  PreparedExecutorAccessChangeSchema,
  SubmitExecutorEnrollmentBodySchema,
} from '../contracts.js'
import { verifyPassword } from '../auth/password.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { launchExecutorRun } from '../services/executor-run-launch.js'
import { setAgentToolPolicyForRegistryEntry } from '../services/agent-tool-policy-registry.js'
import { AgentToolPolicyError } from '../services/agent-tool-policy.js'
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
          || error.code === 'EXECUTOR_COMMAND_REPLAY'
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
  const {
    buildChannelRealtimeScopes,
    config,
    prisma,
    rateLimiter,
    realtimeHub,
    requireActorContext,
    requireUserActor,
  } = deps

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

  app.post('/api/executor-availability', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(ExecutorAvailabilityRequestBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const availability = await resolveExecutorAvailabilityCandidates(prisma, actorContext, body)
      return createApiResponse(ExecutorAvailabilityResponseSchema.parse(availability))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/runs/:runId/executor-bind', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'SCOPE_ENTITLEMENT_DENIED', 'Executor selection requires a human requester.')
      return reply
    }
    const body = parseInput(ExecutorRunBindBodySchema, request.body, reply)
    if (!body) return reply
    const { runId } = request.params as { runId: string }
    try {
      const binding = await bindExecutorCandidate(prisma, {
        actorUserId: actorContext.actor.actorId,
        candidateHandle: body.candidateHandle,
        operationKey: body.operationKey,
        runId,
      })
      return createApiResponse(ExecutorRunBindSchema.parse({
        bindingId: binding.bindingId,
        capabilityRevision: binding.capabilityRevision,
        fence: binding.fence,
        operationKey: binding.operationKey,
        runId: binding.runId,
      }))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  /**
   * Human-directed launch: select an opaque availability choice before a run
   * exists, then create and bind the exact run in one transaction. This is
   * deliberately distinct from asynchronous ordinary-message orchestration.
   */
  app.post('/api/threads/:threadId/executor-runs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const body = parseInput(ExecutorRunLaunchBodySchema, request.body, reply)
    if (!body) return reply
    const { threadId } = request.params as { threadId: string }
    try {
      const launched = await launchExecutorRun(prisma, actorContext, { ...body, threadId })
      if (launched.kind === 'thread_not_found') {
        sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
        return reply
      }
      if (launched.kind === 'agent_unavailable') {
        sendApiError(reply, 404, 'EXECUTOR_AGENT_UNAVAILABLE', 'The selected agent is unavailable in this channel')
        return reply
      }
      if (launched.kind === 'thread_busy') {
        sendApiError(reply, 409, 'RUN_THREAD_BUSY', 'That agent already has active work in this thread')
        return reply
      }
      await realtimeHub.publishWs(
        buildChannelRealtimeScopes({
          channelId: launched.channelId,
          organizationId: actorContext.tenant.organizationId,
        }),
        {
          data: {
            agentId: undefined,
            authorUserId: parseUserId(actorContext.actor.actorId),
            channelId: parseChannelId(launched.channelId),
            contentPreview: launched.message.content.slice(0, 200),
            messageId: launched.message.id,
            role: launched.message.role,
            threadId: launched.message.threadId,
          },
          event: 'message.new',
        },
      )
      await emitAuditEvent(prisma, {
        action: 'executor.run.launched',
        actorContext,
        metadata: {
          agentId: launched.agentId,
          bindingIds: launched.bindings.map((binding) => binding.bindingId),
          operationKeys: launched.bindings.map((binding) => binding.operationKey),
          runId: launched.runId,
        },
        outcome: 'success',
        resourceId: launched.runId,
        resourceType: 'executor_run',
      })
      return reply.code(201).send(createApiResponse(ExecutorRunLaunchSchema.parse({
        bindings: launched.bindings,
        messageId: launched.message.id,
        runId: launched.runId,
        taskId: launched.taskId,
      })))
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

  app.get('/api/executors/:executorId/workspace-reviews', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    try {
      const reviews = await listExecutorWorkspaceReviews(
        prisma,
        deps.authSecret,
        actorContext,
        executorId,
      )
      return createApiResponse(ExecutorWorkspaceReviewRecordSchema.array().parse(reviews))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
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
      if (accessChange.change.kind === 'agent_operation_grant') {
        const tools = await ensureExecutorLogicalTools(prisma, actorContext.tenant.organizationId)
        const toolRegistryEntryId = tools.get(
          ExecutorOperationKeySchema.parse(accessChange.change.operationKey),
        )
        if (!toolRegistryEntryId) {
          throw new Error('Executor logical tool registry is incomplete.')
        }
        // Apply the policy half first. A stale/failed confirmation can only
        // leave a logical grant without the exact executor-operation grant,
        // which remains fail-closed; the reverse ordering could confirm a
        // resource grant and then strand its mandatory policy update.
        await setAgentToolPolicyForRegistryEntry(prisma, {
          agentId: accessChange.change.agentId,
          enabled: accessChange.change.state === 'allowed',
          organizationId: actorContext.tenant.organizationId,
          toolRegistryEntryId,
        })
      }
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
      if (error instanceof AgentToolPolicyError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
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
    '/api/executor-daemon/commands/poll',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonCommandPollBodySchema, request.body, reply)
      if (!body) return reply
      try {
        await authorizeExecutorDaemonControlCall(prisma, {
          connectionEpoch: body.connectionEpoch,
          executorId: body.executorId,
          observedAt: body.observedAt,
          payload: {
            connectionEpoch: body.connectionEpoch,
            executorId: body.executorId,
            observedAt: body.observedAt,
          },
          signature: body.signature,
          type: 'poll',
        })
        const command = await pollExecutorCommand(
          prisma,
          deps.authSecret,
          body.executorId,
        )
        return createApiResponse(ExecutorDaemonCommandPollSchema.parse({ command }))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.post(
    '/api/executor-daemon/commands/receipt',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(ExecutorDaemonCommandReceiptBodySchema, request.body, reply)
      if (!body) return reply
      try {
        await authorizeExecutorDaemonControlCall(prisma, {
          connectionEpoch: body.connectionEpoch,
          executorId: body.executorId,
          observedAt: body.receipt.occurredAt,
          payload: {
            connectionEpoch: body.connectionEpoch,
            executorId: body.executorId,
            receipt: body.receipt,
          },
          signature: body.signature,
          type: 'receipt',
        })
        await recordExecutorCommandReceipt(
          prisma,
          deps.authSecret,
          body.executorId,
          body.receipt,
          body.result,
        )
        return createApiResponse({ recorded: true })
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
        const pending = await submitExecutorEnrollment(prisma, body)
        return createApiResponse(PendingExecutorEnrollmentSchema.parse(pending))
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )
}
