import type { FastifyInstance } from 'fastify'
import { UnreadDirectMessagesResponseSchema } from '@nessie/schemas'

import { createApiResponse } from '../lib/api.js'
import { listUnreadDirectMessages } from '../services/unread-direct-messages.js'
import type { RouteDeps } from './types.js'

export const registerUnreadDirectMessageRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.get('/api/direct-messages/unread', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!deps.requireUserActor(actorContext, reply)) return reply

    const items = await listUnreadDirectMessages(deps.prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(UnreadDirectMessagesResponseSchema.parse({ items }))
  })
}
