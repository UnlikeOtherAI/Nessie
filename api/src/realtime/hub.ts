import type { ServerResponse } from 'node:http'
import {
  createPgPool,
  PgRealtimeTransport,
  type RealtimeNotificationPayload,
  type ThreadStreamEvent,
  type WsEventMessage,
} from '@nessie/runtime'
import type { SseEvent, WsScope } from '@nessie/schemas'

type SseConnection = {
  lastSequence: number
  pending: Extract<RealtimeNotificationPayload, { kind: 'sse' }>[]
  response: ServerResponse
  hydrating: boolean
  threadId: string
}

type WsConnection = {
  scopes: WsScope[]
  send: (message: WsEventMessage) => void
}

const formatSseEvent = (notification: Extract<RealtimeNotificationPayload, { kind: 'sse' }>) =>
  `id: ${notification.sequence}\nevent: ${notification.event}\ndata: ${JSON.stringify(notification.data)}\n\n`

const toScopeKey = (scope: WsScope): string => JSON.stringify(scope)

export const createRealtimeHub = async (input: {
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

    const notificationScopeKeys = new Set(notification.scopes.map(toScopeKey))
    for (const connection of wsConnections) {
      if (!connection.scopes.some((scope) => notificationScopeKeys.has(toScopeKey(scope)))) {
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
    publishWs: async (
      scopes: WsScope[],
      input: {
        data: unknown
        event: string
        ts?: string
      },
    ): Promise<WsEventMessage> => transport.publishWs(scopes, input),
    registerWsConnection: (send: (message: WsEventMessage) => void): WsConnection => {
      const connection: WsConnection = {
        scopes: [],
        send,
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
