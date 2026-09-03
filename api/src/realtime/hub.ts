import type { ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import {
  createPgPool,
  PgRealtimeTransport,
  parseLastRealtimeEventId,
  type RealtimeNotificationPayload,
  type RealtimeReplayEvent,
  type ThreadStreamEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import type { SseEvent, WsScope } from '@nessie/schemas'
import { createRealtimeEventStore } from '../services/realtime-events.js'

type ThreadSseConnection = {
  kind: 'thread'
  lastSequence: number
  pending: Extract<RealtimeNotificationPayload, { kind: 'sse' }>[]
  response: ServerResponse
  hydrating: boolean
  // True while the socket's write buffer is backed up. Ephemeral events are
  // dropped for the duration instead of queued: they carry no sequence, so
  // memory spent holding them buys nothing a re-bootstrap does not.
  saturated: boolean
  threadId: string
}

type UserSseConnection = {
  kind: 'user'
  channelIds: Set<string>
  hydrating: boolean
  lastEventId: bigint
  organizationId: string
  pending: RealtimeReplayEvent[]
  response: ServerResponse
  scopes: WsScope[]
  userId: string
}

type SseConnection = ThreadSseConnection | UserSseConnection

type WsConnection = {
  organizationId: string
  scopes: WsScope[]
  send: (message: WsEventMessage) => void
  userId: string
}

type AddUserSseConnectionInput = {
  kind: 'user'
  channelIds: string[]
  organizationId: string
  scopes: WsScope[]
  userId: string
}

const formatSseEvent = (notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>) => {
  // An ephemeral notification has no `thread_stream_events` row, so its
  // `sequence` is a placeholder: writing it as `id:` would rewind the client's
  // Last-Event-ID and make the next reconnect replay from the wrong point.
  const idLine = notification.ephemeral ? '' : `id: ${notification.sequence}\n`
  return `${idLine}event: ${notification.event}\ndata: ${JSON.stringify(notification.data)}\n\n`
}

// Per-connection backpressure. A slow reader must never grow an unbounded
// in-process buffer, so once the socket reports a full write buffer every
// ephemeral event is dropped for that connection until it drains; the client
// sees a `seq` gap and re-bootstraps over REST. Durable events keep Node's
// own buffering, which the replay watermark already makes recoverable.
const writeThreadSseEvent = (
  connection: ThreadSseConnection,
  notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>,
): void => {
  if (notification.ephemeral && connection.saturated) {
    return
  }

  if (!connection.response.write(formatSseEvent(notification)) && !connection.saturated) {
    connection.saturated = true
    connection.response.once('drain', () => {
      connection.saturated = false
    })
  }
}

const formatUserSseEvent = (event: RealtimeReplayEvent) =>
  `id: ${event.id.toString()}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`

const toScopeKey = (scope: WsScope): string => JSON.stringify(scope)

export const shouldDeliverWsNotification = async (
  input: {
    canAccessChannel: (channelId: string) => Promise<boolean>
    connectionScopes: WsScope[]
    notificationScopes: WsScope[]
  },
): Promise<boolean> => {
  const notificationChannelScopes = input.notificationScopes.filter(
    (scope): scope is Extract<WsScope, { kind: 'channel' }> => scope.kind === 'channel',
  )
  const notificationUserScopes = input.notificationScopes.filter(
    (scope): scope is Extract<WsScope, { kind: 'user' }> => scope.kind === 'user',
  )
  if (notificationUserScopes.length > 0) {
    return input.connectionScopes.some((scope) =>
      scope.kind === 'user' && notificationUserScopes.some((target) =>
        target.userId === scope.userId && target.organizationId === scope.organizationId,
      ),
    )
  }
  const notificationScopeKeys = new Set(input.notificationScopes.map(toScopeKey))

  if (notificationChannelScopes.length > 0) {
    if (!input.connectionScopes.some((scope) => notificationScopeKeys.has(toScopeKey(scope)))) {
      return false
    }

    for (const scope of notificationChannelScopes) {
      if (!(await input.canAccessChannel(scope.channelId))) {
        return false
      }
    }
    return true
  }

  return input.connectionScopes.some((scope) => notificationScopeKeys.has(toScopeKey(scope)))
}

/**
 * The LISTEN-side fan-out, exported so it can be exercised without a live
 * pg LISTEN connection. It never writes to `realtime_events`: the publisher
 * persisted the row before NOTIFYing (`PgRealtimeTransport.publishWs`), so
 * with N api replicas listening, N appends here would corrupt the shared
 * Last-Event-ID sequence. A notification carrying no `eventId` comes from an
 * older publisher mid rolling deploy and is fanned out live with no replay
 * bookkeeping.
 */
export const createWsNotificationDelivery = (input: {
  canAccessChannelEvent?: (input: {
    channelId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
}) => {
  const threadSseConnections = new Set<ThreadSseConnection>()
  const userSseConnections = new Set<UserSseConnection>()
  const wsConnections = new Set<WsConnection>()

  const deliverNotification = async (notification: RealtimeNotificationPayload) => {
    if (notification.kind === 'sse') {
      const ephemeral = notification.ephemeral === true
      for (const connection of threadSseConnections) {
        if (connection.threadId !== notification.threadId) {
          continue
        }
        // Sequence filtering and the watermark only apply to durable events;
        // an ephemeral notification's sequence is a placeholder.
        if (!ephemeral && connection.lastSequence >= notification.sequence) {
          continue
        }

        if (connection.hydrating) {
          // The pending buffer is sequence-sorted, so an ephemeral event has no
          // place in it and is dropped — the bootstrap the client runs after
          // connecting covers the gap by construction.
          if (!ephemeral) {
            connection.pending.push(notification)
          }
          continue
        }

        writeThreadSseEvent(connection, notification)
        if (!ephemeral) {
          connection.lastSequence = notification.sequence
        }
      }
      return
    }

    // The publisher persisted the row before NOTIFYing and carried its id in
    // the payload; a listener must never append — with N api replicas that
    // wrote N copies of the same event and duplicated every replay.
    // During a rolling deploy an old publisher still sends payloads without
    // an id: those are fanned out live only, with no replay bookkeeping, so
    // the mixed-version window can miss a row from replay but never writes a
    // duplicate.
    const replayEventId =
      typeof notification.eventId === 'string'
        ? parseLastRealtimeEventId(notification.eventId)
        : null
    const replayEvent: RealtimeReplayEvent | null =
      replayEventId !== null && replayEventId > 0n
        ? {
            id: replayEventId,
            channelId: null,
            createdAt: new Date(notification.message.ts),
            eventType: notification.message.event,
            payload: notification.message,
            recipientUserId: null,
          }
        : null

    if (replayEvent) {
      for (const connection of userSseConnections) {
        if (connection.lastEventId >= replayEvent.id) {
          continue
        }

        const shouldDeliver = await shouldDeliverWsNotification({
          connectionScopes: connection.scopes,
          notificationScopes: notification.scopes,
          canAccessChannel: async (channelId) =>
            input.canAccessChannelEvent
              ? input.canAccessChannelEvent({
                  channelId,
                  organizationId: connection.organizationId,
                  userId: connection.userId,
                })
              : connection.channelIds.has(channelId),
        })

        if (!shouldDeliver) {
          continue
        }

        if (connection.hydrating) {
          connection.pending.push(replayEvent)
          continue
        }

        connection.response.write(formatUserSseEvent(replayEvent))
        connection.lastEventId = replayEvent.id
      }
    }

    for (const connection of wsConnections) {
      const shouldDeliver = await shouldDeliverWsNotification({
        connectionScopes: connection.scopes,
        notificationScopes: notification.scopes,
        canAccessChannel: async (channelId) =>
          input.canAccessChannelEvent
            ? input.canAccessChannelEvent({
                channelId,
                organizationId: connection.organizationId,
                userId: connection.userId,
              })
            : connection.scopes.some(
                (scope) => scope.kind === 'channel' && scope.channelId === channelId,
              ),
      })

      if (!shouldDeliver) {
        continue
      }

      connection.send(notification.message)
    }
  }

  return {
    deliverNotification,
    threadSseConnections,
    userSseConnections,
    wsConnections,
  }
}

export const createRealtimeHub = async (input: {
  canAccessChannelEvent?: (input: {
    channelId: string
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
  } = createWsNotificationDelivery(input)

  await transport.listen(deliverNotification)

  const addThreadSseConnection = async (
    threadId: string,
    response: ServerResponse,
    lastEventId?: string,
  ): Promise<ThreadSseConnection> => {
    const parsedLastEventId = Number(lastEventId ?? '0')
    const connection: ThreadSseConnection = {
      kind: 'thread',
      lastSequence: Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0,
      pending: [],
      hydrating: true,
      response,
      saturated: false,
      threadId,
    }

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
      input: string | AddUserSseConnectionInput,
      response: ServerResponse,
      lastEventId?: string,
    ): Promise<SseConnection> => {
      return typeof input === 'string'
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
        organizationId: string
        send: (message: WsEventMessage) => void
        userId: string
      },
    ): WsConnection => {
      const connection: WsConnection = {
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
