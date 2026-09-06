import type { FastifyInstance } from 'fastify'

import { sendApiError } from '../lib/api.js'
import { buildStreamCorsHeaders } from '../lib/server-context.js'
import { findThreadForUser } from '../services/message-read-state.js'
import type { RouteDeps } from './types.js'

// Split out of threads.ts (AGENTS.md 500-line budget). The live SSE stream for
// a thread's messages/thinking/document events — gates on thread visibility
// exactly like the routes in threads.ts, then registers the connection with
// the realtime hub by *viewer*, not just thread id, so the hub can re-check
// channel access on every event for the life of the connection (mirroring the
// WS/user-SSE branches in notification-delivery.ts) rather than only once at
// connect time.
export const registerThreadStreamRoute = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config, allowedCorsOrigins, prisma, realtimeHub, requireActorContext } = deps

  app.get('/api/threads/:threadId/stream', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { threadId } = request.params as { threadId: string }
    const thread = await findThreadForUser(
      prisma,
      threadId,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
    )
    if (!thread) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
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
      // Token-by-token delivery only survives if no hop buffers the response:
      // the proxy hint plus Nagle off, matching streamDesignerChat.
      'X-Accel-Buffering': 'no',
    })
    reply.raw.socket?.setNoDelay(true)
    reply.raw.write(': stream connected\n\n')

    const lastEventIdHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader

    // Register cleanup BEFORE awaiting addSseConnection so a half-open socket
    // is still torn down if the client disconnects mid-await.
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
      // Registered by viewer (not thread id alone) so the hub can re-check
      // channel access on every delivered event: a revoked membership stops
      // this stream mid-connection instead of only at reconnect.
      streamConnection = await realtimeHub.addSseConnection(
        {
          kind: 'thread',
          organizationId: actorContext.tenant.organizationId,
          threadId: thread.id,
          userId: actorContext.actor.actorId,
        },
        reply.raw,
        lastEventId,
      )
      // If the socket closed during hydration the close handler fired with
      // streamConnection still null — remove now to avoid orphaning the
      // connection inside the hub.
      if (socketClosed) {
        realtimeHub.removeSseConnection(streamConnection)
      }
    } catch (err) {
      clearInterval(keepAlive)
      reply.raw.end()
      request.log.error({ err }, 'sse_setup_failed')
      return reply
    }
  })
}
