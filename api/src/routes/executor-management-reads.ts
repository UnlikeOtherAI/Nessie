import type { FastifyInstance } from 'fastify'
import {
  ExecutorAgentAccessListQuerySchema, ExecutorAgentAccessRecordSchema, ExecutorAttentionSummarySchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput } from '../lib/api.js'
import { getExecutorAttentionSummary, listExecutorAgentAccess } from '../services/executor-management-reads.js'
import { sendExecutorError } from './executor-route-errors.js'
import type { RouteDeps } from './types.js'

export const registerExecutorManagementReadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/executors/attention', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const summary = await getExecutorAttentionSummary(deps.prisma, actor)
    return createApiResponse(ExecutorAttentionSummarySchema.parse(summary))
  })
  for (const kind of ['agents', 'agent-candidates'] as const) {
    app.get(`/api/executors/:executorId/${kind}`, async (request, reply) => {
      const actor = deps.requireActorContext(request, reply)
      if (!actor || !deps.requireUserActor(actor, reply)) return reply
      const query = parseInput(ExecutorAgentAccessListQuerySchema, request.query, reply, 'query')
      if (!query) return reply
      try {
        const { executorId } = request.params as { executorId: string }
        const page = await listExecutorAgentAccess(deps.prisma, actor, executorId, query, kind === 'agent-candidates')
        return createApiResponse(ExecutorAgentAccessRecordSchema.array().parse(page.data), page.meta)
      } catch (error) {
        if (sendExecutorError(reply, error)) return reply
        throw error
      }
    })
  }
}
