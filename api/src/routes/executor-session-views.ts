import type { FastifyInstance } from 'fastify'
import {
  exchangeExecutorSessionViews, readExecutorSessionView, listExecutorHostSessions,
  listExecutorSessionShares, changeExecutorSessionShare,
} from '@nessie/executor-manage'
import {
  ExecutorSessionViewExchangeSchema, ExecutorSessionViewOffersSchema, ExecutorSessionViewResponseSchema,
  ExecutorHostSessionListSchema, ExecutorSessionSharesSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput } from '../lib/api.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

const ParamsSchema = z.object({ executorId: z.string().uuid(), sessionId: z.string().uuid() }).strict()

export const registerExecutorSessionViewRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/executor-sessions', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    reply.header('Cache-Control', 'no-store')
    return createApiResponse(ExecutorHostSessionListSchema.parse(await listExecutorHostSessions(deps.prisma, actor)))
  })
  const sharePath = '/api/executors/:executorId/coding-sessions/:sessionId/shares'
  app.get(sharePath, async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(ParamsSchema, request.params, reply)
    if (!params) return reply
    reply.header('Cache-Control', 'no-store')
    try {
      return createApiResponse(ExecutorSessionSharesSchema.parse(await listExecutorSessionShares(deps.prisma, actor, params)))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
  app.post(sharePath, async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(ParamsSchema, request.params, reply)
    const body = parseInput(z.object({ email: z.string().email().max(320) }).strict(), request.body, reply)
    if (!params || !body) return reply
    try {
      await changeExecutorSessionShare(deps.prisma, actor, params, body)
      return createApiResponse({ success: true })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
  app.delete(sharePath + '/:userId', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(ParamsSchema.extend({ userId: z.string().uuid() }), request.params, reply)
    if (!params) return reply
    try {
      await changeExecutorSessionShare(deps.prisma, actor, {
        executorId: params.executorId, sessionId: params.sessionId,
      }, { removeUserId: params.userId })
      return createApiResponse({ success: true })
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
  app.get('/api/executors/:executorId/coding-sessions/:sessionId/view', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(ParamsSchema, request.params, reply)
    if (!params) return reply
    reply.header('Cache-Control', 'no-store')
    try {
      return createApiResponse(ExecutorSessionViewResponseSchema.parse(
        await readExecutorSessionView(deps.prisma, deps.encryptionKeyRing, actor, params),
      ))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
  app.post('/api/executor-daemon/session-views', {
    config: { public: true }, bodyLimit: 16 * 1024 * 1024,
  }, async (request, reply) => {
    const body = parseInput(ExecutorSessionViewExchangeSchema, request.body, reply)
    if (!body) return reply
    try {
      return createApiResponse(ExecutorSessionViewOffersSchema.parse(
        await exchangeExecutorSessionViews(deps.prisma, deps.encryptionKeyRing, body),
      ))
    } catch (error) {
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
