import type { FastifyInstance } from 'fastify'
import { requestExecutorCodingSessionClose } from '@nessie/executor-manage'
import {
  ExecutorCodingSessionCloseAcceptedSchema,
  ExecutorCodingSessionCloseBodySchema,
  ExecutorCodingSessionListResponseSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { listExecutorCodingSessions } from '../services/executor-coding-session-reads.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

const UuidSchema = z.string().uuid()

/**
 * The executor page's coding sessions (docs/executor-protocol/
 * host-coding-sessions.md → "The executor page"): the list its Local apps
 * section reads, for the people who manage the machine, and the Close only
 * the person who paired it may press. A Close is accepted, not done — it
 * rides the machine's next heartbeat — so it answers 202.
 */
export const registerExecutorCodingSessionRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  const executorIdOf = (params: unknown): string | null => {
    const parsed = UuidSchema.safeParse((params as { executorId?: string }).executorId)
    return parsed.success ? parsed.data : null
  }

  app.get('/api/executors/:executorId/coding-sessions', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const executorId = executorIdOf(request.params)
    if (!executorId) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor not found.')
      return reply
    }
    try {
      const list = await listExecutorCodingSessions(prisma, actor, executorId)
      return createApiResponse(ExecutorCodingSessionListResponseSchema.parse(list))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/executors/:executorId/coding-sessions/close', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const executorId = executorIdOf(request.params)
    if (!executorId) {
      sendApiError(reply, 404, 'EXECUTOR_NOT_FOUND', 'Executor not found.')
      return reply
    }
    const body = parseInput(ExecutorCodingSessionCloseBodySchema, request.body, reply)
    if (!body) return reply
    try {
      await requestExecutorCodingSessionClose(prisma, actor, { executorId, ...body })
      return reply.code(202).send(createApiResponse(ExecutorCodingSessionCloseAcceptedSchema.parse({
        closing: true, sessionId: body.sessionId,
      })))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
