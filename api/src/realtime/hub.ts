import type { ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import {
  createPgPool,
  PgRealtimeTransport,
  type RealtimeNotificationPayload,
  type ThreadStreamEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import type { SseEvent, WsScope } from '@nessie/schemas'
import {
  createRealtimeEventStore,
  parseLastRealtimeEventId,
  type RealtimeReplayEvent,
} from '../services/realtime-events.js'

type ThreadSseConnection = {
  kind: 'thread'
  lastSequence: number
  pending: Extract<RealtimeNotificationPayload, { kind: 'sse' }>[]
  response: ServerResponse
  hydrating: boolean
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

const formatSseEvent = (notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>) =>
  `id: ${notification.sequence}\nevent: ${notification.event}\ndata: ${JSON.stringify(notification.data)}\n\n`

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
  const threadSseConnections = new Set<ThreadSseConnection>()
  const userSseConnections = new Set<UserSseConnection>()
  const wsConnections = new Set<WsConnection>()

  const deliverNotification = async (notification: RealtimeNotificationPayload) => {
    if (notification.kind === 'sse') {
      for (const connection of threadSseConnections) {
        if (
          connection.threadId !== notification.threadId ||
          connection.lastSequence >= notification.sequence
        ) {
          continue
        }

        if (connection.hydrating) {
          connection.pending.push(notification)
          continue
        }

        connection.response.write(formatSseEvent(notification))
        connection.lastSequence = notification.sequence
      }
      return
    }

    let replayEvent: RealtimeReplayEvent | null = null
    try {
      replayEvent = await realtimeEventStore.append(notification)
    } catch (error) {
      console.error('[realtime] failed to append realtime event:', error)
    }

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
      threadId,
    }

    threadSseConnections.add(connection)

    try {
      const backlog = await transport.listThreadEvents(threadId, connection.lastSequence)
      for (const event of backlog) {
        if (event.sequence <= connection.lastSequence) {
          continue
        }

        // stream.start, stream.reasoning, and stream.delta are ephemeral — don't replay from backlog.
        // A reconnecting client missed the live stream; the final message is already
        // in the messages table. Replaying live chunks would show a zombie pending
        // message or orphaned reasoning until stream.done arrives.
        if (
          event.event === 'stream.start' ||
          event.event === 'stream.reasoning' ||
          event.event === 'stream.delta'
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
      const backlog = await realtimeEventStore.listAfter({
        afterEventId: connection.lastEventId,
        channelIds: [...connection.channelIds],
        organizationId: connection.organizationId,
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
    ): Promise<WsEventMessage> => transport.publishWs(scopes, input),
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
