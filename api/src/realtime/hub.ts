import type { ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import {
  createPgPool,
  PgRealtimeTransport,
  parseLastRealtimeEventId,
  type ThreadStreamEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import type { SseEvent, WsScope } from '@nessie/schemas'
import { createRealtimeEventStore } from '../services/realtime-events.js'
import { createRealtimeDeliveryEntitlements } from './delivery-entitlements.js'
import {
  createWsNotificationDelivery,
  endSseConnectionForShutdown,
  formatSseEvent,
  formatUserSseEvent,
  type AddThreadSseConnectionInput,
  type AddUserSseConnectionInput,
  type SseConnection,
  type ThreadSseConnection,
  type UserSseConnection,
  type WsConnection,
} from './notification-delivery.js'

// The delivery-time authorization and the connection registries live in
// `./notification-delivery.js`; re-exported here because the hub is this
// module's face — every existing importer keeps its path.
export {
  createWsNotificationDelivery,
  shouldDeliverWsNotification,
  type AddThreadSseConnectionInput,
} from './notification-delivery.js'


export const createRealtimeHub = async (input: {
  canAccessChannelEvent?: (input: {
    channelId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
  canAccessDashboardEvent?: (input: {
    dashboardId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
  databaseUrl: string
  poolMax: number
  poolMin: number
  prisma: PrismaClient
}) => {
  const pool = createPgPool(input.databaseUrl, {
    max: input.poolMax,
    min: input.poolMin,
  })
  const transport = new PgRealtimeTransport(pool, input.databaseUrl)
  const realtimeEventStore = createRealtimeEventStore(input.prisma)
  const {
    deliverNotification,
    threadSseConnections,
    userSseConnections,
    wsConnections,
  } = createWsNotificationDelivery({
    ...input,
    entitlements: createRealtimeDeliveryEntitlements(input.prisma),
  })

  await transport.listen(deliverNotification)

  const addThreadSseConnection = async (
    request: string | AddThreadSseConnectionInput,
    response: ServerResponse,
    lastEventId?: string,
  ): Promise<ThreadSseConnection> => {
    const parsedLastEventId = Number(lastEventId ?? '0')
    const connection: ThreadSseConnection = {
      kind: 'thread',
      channelId: null,
      lastSequence: Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0,
      pending: [],
      hydrating: true,
      response,
      saturated: false,
      threadId: typeof request === 'string' ? request : request.threadId,
      viewer:
        typeof request === 'string'
          ? null
          : { organizationId: request.organizationId, userId: request.userId },
    }
    const threadId = connection.threadId

    threadSseConnections.add(connection)

    try {
      const backlog = await transport.listThreadEvents(threadId, connection.lastSequence)
      for (const event of backlog) {
        if (event.sequence <= connection.lastSequence) {
          continue
        }

        // stream.start, stream.reasoning, stream.thinking.tool, stream.delta and
        // stream.document.delta are live-only — don't replay from backlog. A
        // reconnecting client missed the live stream; the final message is already
        // in the messages table, an in-flight run's thought log is re-fetched over
        // REST (GET /api/threads/:threadId/thinking) and a composing document over
        // GET /api/threads/:threadId/document-streams/:sessionId. Replaying live
        // chunks would show a zombie pending message, orphaned reasoning, or
        // duplicated document text until the terminator arrives. The document
        // start/meta/done/error/target events deliberately stay replayable, like
        // stream.done: a reconnect must still learn a session began or ended.
        if (
          event.event === 'stream.start' ||
          event.event === 'stream.reasoning' ||
          event.event === 'stream.thinking.tool' ||
          event.event === 'stream.delta' ||
          event.event === 'stream.document.delta'
        ) {
          connection.lastSequence = event.sequence
          continue
        }

        response.write(formatSseEvent({ kind: 'sse', ...event }))
        connection.lastSequence = event.sequence
      }

      while (connection.pending.length > 0) {
        const batch = connection.pending
        connection.pending = []
        batch.sort((left, right) => left.sequence - right.sequence)

        for (const notification of batch) {
          if (notification.sequence <= connection.lastSequence) {
            continue
          }

          response.write(formatSseEvent(notification))
          connection.lastSequence = notification.sequence
        }
      }
      connection.hydrating = false
      return connection
    } catch (error) {
      threadSseConnections.delete(connection)
      throw error
    }
  }

  const addUserSseConnection = async (
    request: AddUserSseConnectionInput,
    response: ServerResponse,
    lastEventId?: string,
  ): Promise<UserSseConnection> => {
    const connection: UserSseConnection = {
      kind: 'user',
      channelIds: new Set(request.channelIds),
      hydrating: true,
      lastEventId: parseLastRealtimeEventId(lastEventId),
      organizationId: request.organizationId,
      pending: [],
      response,
      scopes: request.scopes,
      userId: request.userId,
    }

    userSseConnections.add(connection)

    try {
      const backlog = await transport.listRealtimeEventsAfter({
        afterEventId: connection.lastEventId,
        channelIds: [...connection.channelIds],
        organizationId: connection.organizationId,
        userId: connection.userId,
      })
      for (const event of backlog) {
        if (event.id <= connection.lastEventId) {
          continue
        }

        response.write(formatUserSseEvent(event))
        connection.lastEventId = event.id
      }

      while (connection.pending.length > 0) {
        const batch = connection.pending
        connection.pending = []
        batch.sort((left, right) => (left.id < right.id ? -1 : 1))

        for (const event of batch) {
          if (event.id <= connection.lastEventId) {
            continue
          }

          response.write(formatUserSseEvent(event))
          connection.lastEventId = event.id
        }
      }
      connection.hydrating = false
      return connection
    } catch (error) {
      userSseConnections.delete(connection)
      throw error
    }
  }

  return {
    addSseConnection: async (
      input: string | AddThreadSseConnectionInput | AddUserSseConnectionInput,
      response: ServerResponse,
      lastEventId?: string,
    ): Promise<SseConnection> => {
      return typeof input === 'string' || input.kind === 'thread'
        ? addThreadSseConnection(input, response, lastEventId)
        : addUserSseConnection(input, response, lastEventId)
    },
    close: async (): Promise<void> => {
      threadSseConnections.clear()
      userSseConnections.clear()
      wsConnections.clear()
      await transport.close()
      await pool.end()
    },
    /**
     * End every live stream this replica is serving, so `app.close()` has only
     * idle sockets left to reap (see `endSseConnectionForShutdown` above for
     * why Fastify cannot do this itself). Synchronous and idempotent: a drain
     * must not await a peer that may never read again.
     *
     * `1012` is the WebSocket "service restart" status — RFC 6455's registry
     * entry that tells a client this close is a deploy, not a protocol error,
     * so it reconnects instead of surfacing a failure.
     */
    closeLiveConnections: (): void => {
      for (const connection of threadSseConnections) {
        endSseConnectionForShutdown(connection.response)
      }
      threadSseConnections.clear()

      for (const connection of userSseConnections) {
        endSseConnectionForShutdown(connection.response)
      }
      userSseConnections.clear()

      for (const connection of wsConnections) {
        try {
          connection.close(1012, 'restart')
        } catch {
          // Socket already torn down by the peer.
        }
      }
      wsConnections.clear()
    },
    // The one `pg.Pool` this process opens outside Prisma. Exposed so the API
    // entrypoint can share it instead of creating a second pool on the same
    // URL — see the connection-ceiling note in `api/src/index.ts`.
    pool,
    removeSseConnection: (connection: SseConnection): void => {
      if (connection.kind === 'thread') {
        threadSseConnections.delete(connection)
        return
      }

      userSseConnections.delete(connection)
    },
    publishSse: async (
      threadId: string,
      event: SseEvent['event'],
      data: SseEvent['data'],
    ): Promise<ThreadStreamEvent> => transport.publishSse(threadId, event, data),
    publishWs: async (
      scopes: WsScope[],
      input: {
        data: unknown
        event: string
        ts?: string
      },
    ): Promise<WsEventMessage> =>
      transport.publishWs(scopes, {
        ...input,
        // Insert through the api's Prisma client so the durable row shares the
        // api's connection lifecycle; the transport still owns the single
        // persist-then-notify shape and carries the row id in the NOTIFY.
        persistEvent: realtimeEventStore.append,
      }),
    registerWsConnection: (
      input: {
        close: (code: number, reason: string) => void
        organizationId: string
        send: (message: WsEventMessage) => void
        userId: string
      },
    ): WsConnection => {
      const connection: WsConnection = {
        close: input.close,
        organizationId: input.organizationId,
        scopes: [],
        send: input.send,
        userId: input.userId,
      }
      wsConnections.add(connection)
      return connection
    },
    removeWsConnection: (connection: WsConnection): void => {
      wsConnections.delete(connection)
    },
    setWsScopes: (connection: WsConnection, scopes: WsScope[]): void => {
      connection.scopes = scopes
    },
  }
}

