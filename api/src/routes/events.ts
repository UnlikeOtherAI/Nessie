import type { FastifyInstance } from 'fastify'
import type { WsScope } from '@nessie/schemas'

import { buildStreamCorsHeaders } from '../lib/server-context.js'
import { markConnected, markDisconnected, touch } from '../services/presence.js'
import { resolveUserChannelRealtimeScopes } from '../services/realtime-events.js'
import type { RouteDeps } from './types.js'

export const registerEventRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    config,
    allowedCorsOrigins,
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

    await markConnected(prisma, userId, organizationId)
    let presenceConnected = true
    const disconnectPresence = async (): Promise<void> => {
      if (!presenceConnected) {
        return
      }

      presenceConnected = false
      try {
        await markDisconnected(prisma, userId)
      } catch (err) {
        request.log.error({ err }, 'user_presence_disconnect_failed')
      }
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      ...buildStreamCorsHeaders({
        origin: request.headers.origin,
        allowedOrigins: allowedCorsOrigins,
        mode: config.mode,
      }),
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
      void touch(prisma, userId).catch((err: unknown) => {
        request.log.error({ err }, 'user_presence_touch_failed')
      })
    }, 15000)

    let streamConnection: Awaited<ReturnType<typeof realtimeHub.addSseConnection>> | null = null
    let socketClosed = false
    request.raw.on('close', () => {
      socketClosed = true
      clearInterval(keepAlive)
      void disconnectPresence()
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
      await disconnectPresence()
      reply.raw.end()
      request.log.error({ err }, 'user_sse_setup_failed')
      return reply
    }

    return reply
  })
}
