import {
  confirmExecutorEnrollment,
  createExecutor,
  ExecutorError,
  getExecutorForUser,
  getPendingExecutorEnrollment,
  listVisibleExecutors,
  submitExecutorEnrollment,
} from '@nessie/executor-manage'
import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  ConfirmExecutorEnrollmentBodySchema,
  CreateExecutorBodySchema,
  CreateExecutorResponseSchema,
  ExecutorRecordSchema,
  PendingExecutorEnrollmentSchema,
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
