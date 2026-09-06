import type { ClientConfig, Notification, Pool } from 'pg'
import { Client } from 'pg'
import {
  SseEventSchema,
  WsEventSchema,
  type SseEvent,
  type WsScope,
} from '@nessie/schemas'

import {
  mapRealtimeEventRow,
  mapThreadStreamEvent,
  notifyRealtime,
  publishThreadStreamEvent,
  publishWsEvent,
  resolveRealtimeNotification,
  type RealtimeEventRow,
  type RealtimeNotificationEnvelope,
  type RealtimeNotificationPayload,
  type RealtimeReplayEvent,
  type ThreadStreamEvent,
  type ThreadStreamEventRow,
  type WsEventMessage,
} from './realtime-publish.js'

export {
  buildSseRefEnvelope,
  buildWsRefEnvelope,
  resolveRealtimeNotification,
  type RealtimeNotificationEnvelope,
  type RealtimeNotificationPayload,
  type RealtimeReplayEvent,
  type ThreadStreamEvent,
  type WsEventMessage,
} from './realtime-publish.js'

// The message announcement envelope rides this transport and is published by
// both processes, so it is reachable wherever the transport is.
export * from './message-envelope.js'

const DEFAULT_NOTIFICATION_CHANNEL = 'nessie_realtime'
const RECONNECT_DELAY_MS = 1_000

const MAX_REPLAY_EVENTS = 5_000
const REALTIME_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000
const REALTIME_EVENT_PRUNE_INTERVAL_MS = 60_000

export const parseLastRealtimeEventId = (
  value: string | undefined,
): bigint => {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return 0n
  }

  return BigInt(trimmed)
}

export const listRealtimeEventsAfterCursor = async (
  pool: Pool,
  input: {
    afterEventId: bigint
    channelIds: string[]
    organizationId: string
    userId: string
  },
): Promise<RealtimeReplayEvent[]> => {
  const result = await pool.query<RealtimeEventRow>(
    `
      SELECT id, organization_id, channel_id, recipient_user_id, event_type, payload, created_at
      FROM realtime_events
      WHERE organization_id = $1
        AND id > $2
        AND (
          channel_id = ANY($3::uuid[])
          OR recipient_user_id = $4
        )
      ORDER BY id ASC
      LIMIT $5
    `,
    [input.organizationId, input.afterEventId, input.channelIds, input.userId, MAX_REPLAY_EVENTS],
  )

  return result.rows.map(mapRealtimeEventRow)
}

export class PgRealtimeTransport {
  private listenerClient: Client | null = null
  private listenerClosed = false
  private listenerConnectPromise: Promise<void> | null = null
  private notificationHandler:
    | ((payload: RealtimeNotificationPayload) => void | Promise<void>)
    | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastPruneAt = 0

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

  async listThreadEvents(
    threadId: string,
    afterSequence = 0,
    options: { activeRunsOnly?: boolean } = {},
  ): Promise<ThreadStreamEvent[]> {
    // On fresh connects (afterSequence=0), only replay events tied to runs
    // that are still active (pending/running). Historical events from
    // completed/failed/cancelled runs should not come back to life as
    // "pending" stream entries in the client. On reconnect (afterSequence>0)
    // we always replay everything since `afterSequence` so the client can
    // resume state without gaps.
    const shouldFilterToActive = options.activeRunsOnly ?? afterSequence === 0

    if (shouldFilterToActive) {
      const result = await this.pool.query<ThreadStreamEventRow>(
        `
          SELECT e.id, e.thread_id, e.event_name, e.data, e.created_at
          FROM thread_stream_events e
          WHERE e.thread_id = $1
            AND e.id > $2
            AND (
              (e.data->>'runId') IS NULL
              OR EXISTS (
                SELECT 1 FROM runs r
                WHERE r.id::text = e.data->>'runId'
                  AND r.status IN ('pending', 'running')
              )
            )
          ORDER BY e.id ASC
        `,
        [threadId, afterSequence],
      )

      return result.rows.map(mapThreadStreamEvent)
    }

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

        let envelope: RealtimeNotificationEnvelope
        try {
          envelope = JSON.parse(notification.payload) as RealtimeNotificationEnvelope
        } catch {
          // Ignore malformed notifications. They are not recoverable locally.
          return
        }

        // A payload too large for NOTIFY travelled as its row id, so the row is
        // read back here and nothing above the transport ever meets the compact
        // form. That read costs a round trip, so such an event can reach the
        // fan-out behind a smaller one published after it; the connection
        // watermark then skips it and the client picks it up on its next
        // reconnect replay — which is exactly what an over-limit NOTIFY did
        // before it was made survivable, and far short of losing the row.
        void resolveRealtimeNotification(this.pool, envelope)
          .then((payload) => (payload ? onNotification(payload) : undefined))
          .catch(() => {
            // The row could not be read back; replay recovers it on reconnect.
          })
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

  /**
   * Durable thread publish: one transaction on one pooled client, serialised
   * per thread by an advisory lock so id order equals commit order — see
   * `publishThreadStreamEvent`.
   */
  async publishSse(
    threadId: string,
    event: SseEvent['event'],
    data: SseEvent['data'],
  ): Promise<ThreadStreamEvent> {
    return publishThreadStreamEvent(this.pool, this.channel, { data, event, threadId })
  }

  /**
   * Publish without persisting.
   *
   * Live document deltas arrive once per provider chunk. Giving each one a
   * durable row (as `stream.delta` does) costs an INSERT plus a NOTIFY per
   * token and buys nothing: a client that missed them rebuilds from the
   * document-stream bootstrap route, which is cheaper and exact. Ordering
   * still holds — the caller serializes its own publishes.
   */
  async publishSseEphemeral(
    threadId: string,
    event: SseEvent['event'],
    data: SseEvent['data'],
  ): Promise<void> {
    const parsed = SseEventSchema.parse({ event, data })
    await notifyRealtime(this.pool, this.channel, {
      data: parsed.data,
      ephemeral: true,
      event: parsed.event,
      kind: 'sse',
      // No row, so no real sequence. `ephemeral` is what the hub branches on.
      sequence: 0,
      threadId,
      ts: new Date().toISOString(),
    })
  }

  private async pruneOldRealtimeEvents(): Promise<void> {
    const now = Date.now()
    if (now - this.lastPruneAt < REALTIME_EVENT_PRUNE_INTERVAL_MS) {
      return
    }

    this.lastPruneAt = now
    await this.pool.query(
      'DELETE FROM realtime_events WHERE created_at < $1',
      [new Date(now - REALTIME_EVENT_RETENTION_MS)],
    )
  }

  /**
   * Durable ws publish: the `realtime_events` row and its NOTIFY land in one
   * transaction, serialised per organization by an advisory lock so id order
   * equals commit order — see `publishWsEvent`. The transport is the only
   * writer; a listener must never append.
   */
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

    const replayEvent = await publishWsEvent(this.pool, this.channel, { message, scopes })
    if (replayEvent) {
      await this.pruneOldRealtimeEvents()
    }

    return message
  }

  /**
   * Broadcast a session revocation to every listening replica. Fire-and-forget
   * by design: the durable authority is the `auth_sessions` row the caller
   * already wrote, and every replica re-reads it when its own cache entry
   * expires, so a lost NOTIFY costs latency (up to the cache TTL) and never
   * correctness.
   */
  async publishSessionRevocation(sessionId: string): Promise<void> {
    await notifyRealtime(this.pool, this.channel, { kind: 'auth', sessionId })
  }

  listRealtimeEventsAfter(input: {
    afterEventId: bigint
    channelIds: string[]
    organizationId: string
    userId: string
  }): Promise<RealtimeReplayEvent[]> {
    return listRealtimeEventsAfterCursor(this.pool, input)
  }
}
