import type { FastifyInstance } from 'fastify'
import { attributionFromActorContext } from '@nessie/runtime'
import { AgentIdSchema, ChannelIdSchema } from '@nessie/schemas'
import { z } from 'zod'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { loadAgentConversationSuggestions } from '../services/agent-conversation-suggestions.js'
import type { RouteDeps } from './types.js'

export const registerAgentConversationSuggestionRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/agents/:agentId/conversation-suggestions', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(z.object({ agentId: AgentIdSchema }), request.params, reply)
    const query = parseInput(z.object({ channelId: ChannelIdSchema }), request.query, reply)
    if (!params || !query) return reply
    reply.header('Cache-Control', 'no-store')
    const result = await loadAgentConversationSuggestions({
      prisma: deps.prisma, modelClient: deps.sharedModelClient,
    }, {
      ...params, ...query,
      organizationId: actor.tenant.organizationId, userId: actor.actor.actorId,
      usage: attributionFromActorContext(actor, { systemComponent: 'agent-home-suggestions' }),
    })
    if (!result) {
      sendApiError(reply, 404, 'AGENT_HOME_NOT_FOUND', 'Agent conversation home not found')
      return reply
    }
    return createApiResponse(result)
  })
}
