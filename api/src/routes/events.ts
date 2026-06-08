import type { FastifyInstance } from 'fastify'
import type { WsScope } from '@nessie/schemas'

import { resolveUserChannelRealtimeScopes } from '../services/realtime-events.js'
import type { RouteDeps } from './types.js'

export const registerEventRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    requireUserActor,
    buildChannelRealtimeScopes,
  } = deps

  app.get('/api/events/stream', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const organizationId = actorContext.tenant.organizationId
    const userId = actorContext.actor.actorId
    const scopes = await resolveUserChannelRealtimeScopes(prisma, {
      buildChannelRealtimeScopes,
      organizationId,
      userId,
    })
    const channelIds = scopes
      .filter(
        (scope): scope is Extract<WsScope, { kind: 'channel' }> =>
          scope.kind === 'channel',
      )
      .map((scope) => scope.channelId)

    reply.hijack()
    reply.raw.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    })
    reply.raw.write(': connected\n\n')

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader

    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n')
    }, 15000)

    let streamConnection: Awaited<ReturnType<typeof realtimeHub.addSseConnection>> | null = null
    let socketClosed = false
    request.raw.on('close', () => {
      socketClosed = true
      clearInterval(keepAlive)
      if (streamConnection) {
        realtimeHub.removeSseConnection(streamConnection)
      }
      reply.raw.end()
    })

    try {
      streamConnection = await realtimeHub.addSseConnection(
        {
          kind: 'user',
          channelIds,
          organizationId,
          scopes,
          userId,
        },
        reply.raw,
        lastEventId,
      )
      if (socketClosed) {
        realtimeHub.removeSseConnection(streamConnection)
      }
    } catch (err) {
      clearInterval(keepAlive)
      reply.raw.end()
      request.log.error({ err }, 'user_sse_setup_failed')
      return reply
    }

    return reply
  })
}
