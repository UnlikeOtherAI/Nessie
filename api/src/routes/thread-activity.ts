import type { FastifyInstance } from 'fastify'

import { ListThreadActivityQuerySchema, ThreadActivityResponseSchema } from '../contracts.js'
import { createApiResponse, parseInput } from '../lib/api.js'
import { listThreadActivity } from '../services/thread-activity.js'
import type { RouteDeps } from './types.js'

export const registerThreadActivityRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/threads/activity', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!deps.requireUserActor(actorContext, reply)) return reply
    const query = parseInput(ListThreadActivityQuerySchema, request.query ?? {}, reply)
    if (!query) return reply
    const { unread, ...pagination } = query
    const result = await listThreadActivity(deps.prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
      ...pagination,
      unreadOnly: unread === 'true' || unread === '1',
    })
    return createApiResponse(ThreadActivityResponseSchema.parse({
      ...result.data,
      hasMore: result.meta.hasMore,
      nextCursor: result.meta.cursor ?? undefined,
    }), result.meta)
  })
}
