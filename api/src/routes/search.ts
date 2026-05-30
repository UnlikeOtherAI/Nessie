import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { MessageSearchQuerySchema, MessageSearchResultSchema } from '../contracts.js'
import { createApiResponse, parseInput } from '../lib/api.js'
import { searchMessages } from '../services/messages.js'
import type { RouteDeps } from './types.js'

export const registerSearchRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  const runSearch = async (
    request: FastifyRequest,
    reply: FastifyReply,
    channelId?: string,
  ) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = parseInput(MessageSearchQuerySchema, request.query ?? {}, reply)
    if (!query) {
      return reply
    }

    const results = await searchMessages(prisma, {
      after: query.after,
      before: query.before,
      channelId: channelId ?? query.channelId,
      isOwner: actorContext.actor.roles?.includes('owner') ?? false,
      limit: query.limit,
      organizationId: actorContext.tenant.organizationId,
      query: query.query,
      senderId: query.senderId,
      userId: actorContext.actor.actorId,
    })

    return createApiResponse(MessageSearchResultSchema.array().parse(results))
  }

  app.get('/api/messages/search', async (request, reply) => runSearch(request, reply))

  app.get('/api/channels/:channelId/messages/search', async (request, reply) => {
    const { channelId } = request.params as { channelId: string }
    return runSearch(request, reply, channelId)
  })
}
