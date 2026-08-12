import {
  confirmExecutorEnrollment,
  createExecutor,
  ExecutorError,
  getExecutorForUser,
  getPendingExecutorEnrollment,
  listVisibleExecutors,
  removePrivateAssignment,
  setExecutorAgentOperationGrant,
  setPrivateAssignment,
  submitExecutorEnrollment,
  reviewExecutorDescriptor,
  transitionExecutorLifecycle,
} from '@nessie/executor-manage'
import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  ConfirmExecutorEnrollmentBodySchema,
  CreateExecutorBodySchema,
  CreateExecutorResponseSchema,
  ExecutorRecordSchema,
  PendingExecutorEnrollmentSchema,
  ExecutorLifecycleBodySchema,
  RemovePrivateAssignmentParamsSchema,
  ReviewExecutorDescriptorBodySchema,
  SetExecutorAgentOperationGrantBodySchema,
  SetPrivateAssignmentBodySchema,
  SubmitExecutorEnrollmentBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const sendExecutorError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof ExecutorError)) return false
  const status = error.code === 'EXECUTOR_NOT_FOUND'
    ? 404
    : error.code === 'SCOPE_ENTITLEMENT_DENIED'
      ? 403
      : error.code === 'EXECUTOR_STATE_TRANSITION_INVALID'
          || error.code === 'EXECUTOR_PRIVATE_FINAL_ADMIN_REQUIRED'
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
  const { prisma, requireActorContext } = deps

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

  app.put('/api/executors/:executorId/private-assignments', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const body = parseInput(SetPrivateAssignmentBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const authorizationRevision = await setPrivateAssignment(prisma, actorContext, {
        executorId,
        assignment: body.assignment,
      })
      return createApiResponse({ authorizationRevision })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.delete(
    '/api/executors/:executorId/private-assignments/:principalKind/:principalId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      const params = parseInput(RemovePrivateAssignmentParamsSchema, request.params, reply)
      if (!params) return reply
      try {
        const authorizationRevision = await removePrivateAssignment(prisma, actorContext, {
          executorId: params.executorId,
          principal: params.principalKind === 'user'
            ? { principalKind: 'user', userId: params.principalId }
            : { principalKind: 'agent', agentId: params.principalId },
        })
        return createApiResponse({ authorizationRevision })
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    },
  )

  app.put('/api/executors/:executorId/agent-operation-grants', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const body = parseInput(SetExecutorAgentOperationGrantBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const authorizationRevision = await setExecutorAgentOperationGrant(prisma, actorContext, {
        executorId,
        ...body,
      })
      return createApiResponse({ authorizationRevision })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/executors/:executorId/lifecycle', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { executorId } = request.params as { executorId: string }
    const body = parseInput(ExecutorLifecycleBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const result = await transitionExecutorLifecycle(prisma, actorContext, {
        executorId,
        action: body.action,
      })
      return createApiResponse(result)
    } catch (error) {
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
