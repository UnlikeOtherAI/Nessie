import type { ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import {
  createPgPool,
  PgRealtimeTransport,
  parseLastRealtimeEventId,
  type ThreadStreamEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import type { DocumentSseEventName, SseEvent, WsScope } from '@nessie/schemas'
import { createConnectionHydration } from './connection-hydration.js'
import { createRealtimeDeliveryEntitlements } from './delivery-entitlements.js'
import { canReadSpaceForDocumentLane } from './knowledge-page-entitlement.js'
import type { DocumentSseConnection } from './document-lane.js'
import {
  createWsNotificationDelivery,
  endSseConnectionForShutdown,
  type AddThreadSseConnectionInput,
  type AddUserSseConnectionInput,
  type SseConnection,
  type ThreadSseConnection,
  type UserSseConnection,
  type WsConnection,
} from './notification-delivery.js'
import type { RealtimeFanOutLogger } from './watermark.js'

// The delivery-time authorization and the connection registries live in
// `./notification-delivery.js`; re-exported here because the hub is this
// module's face — every existing importer keeps its path.
export {
  createWsNotificationDelivery,
  shouldDeliverWsNotification,
  type AddThreadSseConnectionInput,
} from './notification-delivery.js'
export type { RealtimeFanOutLogger } from './watermark.js'


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
  logger?: RealtimeFanOutLogger
  /**
   * Drop one `sid` from this replica's session-revocation cache when another
   * replica announces a logout. Wired from the composition root to the
   * checker's own `invalidate`; the hub only carries it to the listener.
   */
  onSessionRevoked?: (sessionId: string) => void
  poolMax: number
  poolMin: number
  prisma: PrismaClient
}) => {
  const pool = createPgPool(input.databaseUrl, {
    max: input.poolMax,
    min: input.poolMin,
  })
  const transport = new PgRealtimeTransport(pool, input.databaseUrl)
  const {
    deliverNotification,
    documentConnections,
    threadSseConnections,
    userSseConnections,
    wsConnections,
  } = createWsNotificationDelivery({
    ...input,
    entitlements: {
      ...createRealtimeDeliveryEntitlements(input.prisma),
      // Lives here rather than in `delivery-entitlements.ts` because it needs
      // `@nessie/knowledge` — the space viewer, `canReadSpace`, and the
      // every-version-readable rule the page routes already enforce. The lane
      // memoises it for 5 s per connection.
      canAccessKnowledgePage: (page) => canReadSpaceForDocumentLane(input.prisma, page),
    },
  })

  const { hydrateThreadConnection, hydrateUserConnection, resyncRegisteredConnections } =
    createConnectionHydration({
      logger: input.logger,
      threadSseConnections,
      transport,
      userSseConnections,
    })

  // A dropped LISTEN re-listens by itself, which restores future notifications
  // and nothing else: the connections this replica is already holding are kept
  // open by keepalives, so no client reconnect fires and nothing goes and
  // fetches what the gap swallowed (horizontal-scaling audit 2.2). This is the
  // half that closes it — every registered connection is re-read from its own
  // watermark as soon as the LISTEN comes back.
  await transport.listen(deliverNotification, {
    onListenRecovered: resyncRegisteredConnections,
  })

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
    threadSseConnections.add(connection)

    try {
      await hydrateThreadConnection(connection)
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
      await hydrateUserConnection(connection)
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
    addDocumentConnection: (
      request: {
        pageId: string
        spaceId: string
        organizationId: string
        userId: string
        clientId: string
      },
      response: ServerResponse,
    ): DocumentSseConnection => {
      // No hydration and no pending buffer: the lane is ephemeral by
      // construction, and the client bootstraps over REST after the stream is
      // open (the bootstrap carries `headSeq`, so anything delivered below it
      // is discarded and a gap is filled from the catch-up route).
      const connection: DocumentSseConnection = {
        kind: 'document',
        pageId: request.pageId,
        spaceId: request.spaceId,
        organizationId: request.organizationId,
        userId: request.userId,
        clientId: request.clientId,
        response,
        saturated: false,
      }
      documentConnections.add(connection)
      return connection
    },
    removeDocumentConnection: (connection: DocumentSseConnection): void => {
      documentConnections.delete(connection)
    },
    publishDocumentEphemeral: (
      pageId: string,
      organizationId: string,
      event: DocumentSseEventName,
      data: unknown,
    ): Promise<{ inlined: boolean }> =>
      transport.publishDocumentEphemeral(pageId, organizationId, event, data),
    close: async (): Promise<void> => {
      threadSseConnections.clear()
      userSseConnections.clear()
      wsConnections.clear()
      documentConnections.clear()
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

      for (const connection of documentConnections) {
        endSseConnectionForShutdown(connection.response)
      }
      documentConnections.clear()

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
    /**
     * Tell every replica to forget one revoked `sid` now. The caller has
     * already written the durable revocation and invalidated its own cache;
     * this only removes the other replicas' TTL wait.
     */
    publishSessionRevocation: (sessionId: string): Promise<void> =>
      transport.publishSessionRevocation(sessionId),
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
    ): Promise<WsEventMessage> => transport.publishWs(scopes, input),
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

