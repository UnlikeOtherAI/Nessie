import type { ServerResponse } from 'node:http'
import {
  createPgPool,
  PgRealtimeTransport,
  type RealtimeNotificationPayload,
  type ThreadStreamEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import { parseAgentId, parseRunId } from '@nessie/schemas'
import type { SseEvent, WsScope } from '@nessie/schemas'

type SseConnection = {
  lastSequence: number
  pending: Extract<RealtimeNotificationPayload, { kind: 'sse' }>[]
  response: ServerResponse
  hydrating: boolean
  threadId: string
}

type WsConnection = {
  organizationId: string
  scopes: WsScope[]
  send: (message: WsEventMessage) => void
  userId: string
}

const formatSseEvent = (notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>) =>
  `id: ${notification.sequence}\nevent: ${notification.event}\ndata: ${JSON.stringify(notification.data)}\n\n`

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
}) => {
  const pool = createPgPool(input.databaseUrl, {
    max: input.poolMax,
    min: input.poolMin,
  })
  const transport = new PgRealtimeTransport(pool, input.databaseUrl)
  const sseConnections = new Set<SseConnection>()
  const wsConnections = new Set<WsConnection>()

  const deliverNotification = async (notification: RealtimeNotificationPayload) => {
    if (notification.kind === 'sse') {
      for (const connection of sseConnections) {
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

  return {
    addSseConnection: async (
      threadId: string,
      response: ServerResponse,
      lastEventId?: string,
    ): Promise<SseConnection> => {
      const parsedLastEventId = Number(lastEventId ?? '0')
      const connection: SseConnection = {
        lastSequence: Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0,
        pending: [],
        hydrating: true,
        response,
        threadId,
      }

      sseConnections.add(connection)

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
        sseConnections.delete(connection)
        throw error
      }
    },
    close: async (): Promise<void> => {
      sseConnections.clear()
      wsConnections.clear()
      await transport.close()
      await pool.end()
    },
    removeSseConnection: (connection: SseConnection): void => {
      sseConnections.delete(connection)
    },
    publishSse: async (
      threadId: string,
      event: SseEvent['event'],
      data: SseEvent['data'],
    ): Promise<ThreadStreamEvent> => transport.publishSse(threadId, event, data),
    publishCancellation: async (threadId: string, runId: string): Promise<void> => {
      await transport.publishSse(threadId, 'stream.done', {
        agentId: '',
        content: 'Run cancelled.',
        createdAt: new Date().toISOString(),
        messageId: `run-cancelled:${runId}`,
        runId,
      })
    },
    publishCancellation: async (threadId: string, runId: string): Promise<void> => {
      await transport.publishSse(threadId, 'stream.done', {
        agentId: '',
        content: 'Run cancelled.',
        createdAt: new Date().toISOString(),
        messageId: `run-cancelled:${runId}`,
        runId,
      })
    },
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
