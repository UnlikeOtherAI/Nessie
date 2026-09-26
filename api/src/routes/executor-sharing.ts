import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { ExecutorSharingUpdateSchema, ExecutorSharingViewSchema } from '@nessie/schemas'
import { getExecutorSharing, updateExecutorSharing } from '@nessie/executor-manage'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { AgentToolPolicyError } from '../services/agent-tool-policy.js'
import { applyExecutorAgentAccessChange } from './executor-agent-access-change.js'
import { sendExecutorError } from './executor-route-errors.js'
import { notifyExecutorStatus } from './executor-status-events.js'
import { notifyExecutorLeaseChanges } from './executor-leases.js'
import type { RouteDeps } from './types.js'

const Params = z.object({ executorId: z.string().uuid() }).strict()
const Query = z.object({ teamId: z.string().uuid() }).strict()
const AgentChange = z.object({ agentId: z.string().uuid(), state: z.enum(['allowed', 'denied']) }).strict()

export const registerExecutorSharingRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/executors/:executorId/sharing', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(Params, request.params, reply)
    const query = parseInput(Query, request.query, reply)
    if (!params || !query) return reply
    try {
      return createApiResponse(ExecutorSharingViewSchema.parse(
        await getExecutorSharing(deps.prisma, actor, params.executorId, query.teamId),
      ))
    } catch (error) { if (sendExecutorError(reply, error)) return reply; throw error }
  })
  app.put('/api/executors/:executorId/sharing', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(Params, request.params, reply)
    const body = parseInput(ExecutorSharingUpdateSchema, request.body, reply)
    if (!params || !body) return reply
    try {
      const endedLeases = await updateExecutorSharing(deps.prisma, actor, { ...params, ...body })
      await notifyExecutorLeaseChanges(deps, request.log, endedLeases)
      await notifyExecutorStatus(deps, request.log, params.executorId, actor.tenant.organizationId)
      return createApiResponse({ updated: true })
    } catch (error) { if (sendExecutorError(reply, error)) return reply; throw error }
  })
  app.put('/api/executors/:executorId/agents', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(Params, request.params, reply)
    const body = parseInput(AgentChange, request.body, reply)
    if (!params || !body) return reply
    try {
      await applyExecutorAgentAccessChange(deps, request.log, actor, { ...params, ...body })
      return createApiResponse({ updated: true })
    } catch (error) {
      if (error instanceof AgentToolPolicyError) {
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      if (sendExecutorError(reply, error)) return reply
      throw error
    }
  })
}
