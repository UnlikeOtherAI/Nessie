import type { ClientConfig, Notification, Pool } from 'pg'
import { Client } from 'pg'
import {
  SseEventSchema,
  WsEventSchema,
  type SseEvent,
  type WsScope,
} from '@nessie/schemas'

const DEFAULT_NOTIFICATION_CHANNEL = 'nessie_realtime'
const RECONNECT_DELAY_MS = 1_000

type ThreadStreamEventRow = {
  created_at: Date
  data: unknown
  event_name: SseEvent['event']
  id: number
  thread_id: string
}

export type ThreadStreamEvent = {
  data: SseEvent['data']
  event: SseEvent['event']
  sequence: number
  threadId: string
  ts: string
}

export type WsEventMessage = {
  data: unknown
  event: string
  ts: string
  type: 'event'
}

export type RealtimeNotificationPayload =
  | ({
      kind: 'sse'
    } & ThreadStreamEvent)
  | {
      kind: 'ws'
      message: WsEventMessage
      scopes: WsScope[]
    }

const mapThreadStreamEvent = (row: ThreadStreamEventRow): ThreadStreamEvent => ({
  data: SseEventSchema.parse({
    event: row.event_name,
    data: row.data,
  }).data,
  event: row.event_name,
  sequence: row.id,
  threadId: row.thread_id,
  ts: row.created_at.toISOString(),
})

const notify = async (
  pool: Pool,
  channel: string,
  payload: RealtimeNotificationPayload,
): Promise<void> => {
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)])
}

export class PgRealtimeTransport {
  private listenerClient: Client | null = null
  private listenerClosed = false
  private listenerConnectPromise: Promise<void> | null = null
  private notificationHandler:
    | ((payload: RealtimeNotificationPayload) => void | Promise<void>)
    | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly pool: Pool,
    private readonly connectionConfig: string | ClientConfig,
    private readonly channel = DEFAULT_NOTIFICATION_CHANNEL,
  ) {}

  async close(): Promise<void> {
    this.listenerClosed = true
    this.notificationHandler = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (!this.listenerClient) {
      return
    }

    this.listenerClient.removeAllListeners()
    await this.listenerClient.end()
    this.listenerClient = null
  }

  async listThreadEvents(threadId: string, afterSequence = 0): Promise<ThreadStreamEvent[]> {
    const result = await this.pool.query<ThreadStreamEventRow>(
      `
        SELECT id, thread_id, event_name, data, created_at
        FROM thread_stream_events
        WHERE thread_id = $1
          AND id > $2
        ORDER BY id ASC
      `,
      [threadId, afterSequence],
    )

    return result.rows.map(mapThreadStreamEvent)
  }

  private resetListener(client: Client): void {
    if (this.listenerClient !== client) {
      return
    }

    client.removeAllListeners()
    this.listenerClient = null
  }

  private scheduleReconnect(): void {
    if (this.listenerClosed || this.reconnectTimer || !this.notificationHandler) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.notificationHandler) {
        return
      }

      void this.listen(this.notificationHandler).catch(() => {
        this.scheduleReconnect()
      })
    }, RECONNECT_DELAY_MS)
  }

  async listen(
    onNotification: (payload: RealtimeNotificationPayload) => void | Promise<void>,
  ): Promise<void> {
    this.listenerClosed = false
    this.notificationHandler = onNotification

    if (this.listenerClient) {
      return
    }

    if (this.listenerConnectPromise) {
      await this.listenerConnectPromise
      return
    }

    this.listenerConnectPromise = (async () => {
      const client = new Client(this.connectionConfig)
      const handleDisconnect = () => {
        this.resetListener(client)
        this.scheduleReconnect()
      }

      client.on('error', handleDisconnect)
      client.on('end', handleDisconnect)
      client.on('notification', (notification: Notification) => {
        if (!notification.payload) {
          return
        }

        try {
          const payload = JSON.parse(notification.payload) as RealtimeNotificationPayload
          void onNotification(payload)
        } catch {
          // Ignore malformed notifications. They are not recoverable locally.
        }
      })

      try {
        await client.connect()
        await client.query(`LISTEN ${this.channel}`)
        this.listenerClient = client
      } catch (error) {
        client.removeAllListeners()
        await client.end().catch(() => undefined)
        throw error
      }
    })()

    try {
      await this.listenerConnectPromise
    } finally {
      this.listenerConnectPromise = null
    }
  }

  async publishSse(
    threadId: string,
    event: SseEvent['event'],
    data: SseEvent['data'],
  ): Promise<ThreadStreamEvent> {
    const parsed = SseEventSchema.parse({ event, data })
    const result = await this.pool.query<ThreadStreamEventRow>(
      `
        INSERT INTO thread_stream_events (
          thread_id,
          event_name,
          data,
          created_at
        )
        VALUES ($1, $2, $3::jsonb, now())
        RETURNING id, thread_id, event_name, data, created_at
      `,
      [threadId, parsed.event, JSON.stringify(parsed.data)],
    )

    const record = mapThreadStreamEvent(result.rows[0]!)
    await notify(this.pool, this.channel, {
      kind: 'sse',
      ...record,
    })
    return record
  }

  async publishWs(
    scopes: WsScope[],
    input: {
      data: unknown
      event: string
      ts?: string
    },
  ): Promise<WsEventMessage> {
    const message = WsEventSchema.parse({
      type: 'event',
      event: input.event,
      data: input.data,
      ts: input.ts ?? new Date().toISOString(),
    })

    await notify(this.pool, this.channel, {
      kind: 'ws',
      message,
      scopes,
    })

    return message
  }
}
