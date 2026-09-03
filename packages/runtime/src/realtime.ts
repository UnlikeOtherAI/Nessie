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
      /**
       * Notify-only: no `thread_stream_events` row exists, so `sequence` is a
       * placeholder the hub must not surface as an SSE `id:` or store as a
       * connection watermark. Reconnecting clients repair over REST instead.
       */
      ephemeral?: boolean
    } & ThreadStreamEvent)
  | {
      /**
       * Id of the `realtime_events` row the publisher persisted before
       * notifying. Absent only when the publisher is an older build mid
       * rolling deploy: listeners then fan out live without replay
       * bookkeeping for that one event.
       */
      eventId?: string
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

const MAX_REPLAY_EVENTS = 5_000
const REALTIME_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000
const REALTIME_EVENT_PRUNE_INTERVAL_MS = 60_000

export type RealtimeReplayEvent = {
  id: bigint
  channelId: string | null
  eventType: string
  payload: unknown
  createdAt: Date
  recipientUserId: string | null
}

type RealtimeEventRow = {
  id: bigint | number
  organization_id: string
  channel_id: string | null
  recipient_user_id: string | null
  event_type: string
  payload: unknown
  created_at: Date
}

const mapRealtimeEventRow = (row: RealtimeEventRow): RealtimeReplayEvent => ({
  id: BigInt(row.id),
  channelId: row.channel_id,
  eventType: row.event_type,
  payload: row.payload,
  createdAt: row.created_at,
  recipientUserId: row.recipient_user_id,
})

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

const notify = async (
  pool: Pool,
  channel: string,
  payload: RealtimeNotificationPayload,
): Promise<void> => {
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)])
}

/**
 * Persisted write side of the ws realtime lane. Every event is persisted
 * exactly once, at publish time inside `PgRealtimeTransport.publishWs` —
 * never in a LISTEN handler, where each api replica would append its own
 * copy and corrupt the Last-Event-ID sequence. Mirrors the SSE lane's
 * persist-then-notify shape. Callers that must insert through a different
 * path (a Prisma transaction) can use this type as a structural seam.
 */
export type PersistedRealtimeEventWriter = (input: {
  message: WsEventMessage
  scopes: WsScope[]
}) => Promise<RealtimeReplayEvent | null>

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
    await notify(this.pool, this.channel, {
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
   * Insert the durable `realtime_events` row for one ws publication and
   * return it, or `null` when the publication has no deliverable target
   * (a scope list with neither a channel nor a user scope) or when the
   * organization cannot be resolved. The publisher is the only writer, so a
   * null row also means no persisted replay — exactly the previous
   * append-at-listen semantics, without the per-replica duplication.
   */
  private async appendWsEvent(
    scopes: WsScope[],
    message: WsEventMessage,
  ): Promise<RealtimeReplayEvent | null> {
    const channelScope = scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'channel' }> => scope.kind === 'channel',
    )
    const userScope = scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'user' }> => scope.kind === 'user',
    )
    if (!channelScope && !userScope) {
      return null
    }

    const organizationScope = scopes.find(
      (scope): scope is Extract<WsScope, { kind: 'organization' }> =>
        scope.kind === 'organization',
    )
    // A user-scoped publication (the incoming-call ring) carries neither an
    // organization nor a channel scope, but the user scope names its own
    // organization. Without this fallback no row would be written, and the
    // hub gates the whole user-SSE fan-out on a persisted row.
    let organizationId: string | null = organizationScope?.organizationId ?? null
    if (!organizationId && channelScope) {
      const channel = await this.pool.query<{ organization_id: string }>(
        'SELECT organization_id FROM channels WHERE id = $1',
        [channelScope.channelId],
      )
      organizationId = channel.rows[0]?.organization_id ?? null
    }
    organizationId ??= userScope?.organizationId ?? null
    if (!organizationId) {
      return null
    }

    const result = await this.pool.query<RealtimeEventRow>(
      `
        INSERT INTO realtime_events (
          organization_id,
          channel_id,
          recipient_user_id,
          event_type,
          payload,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, now())
        RETURNING id, organization_id, channel_id, recipient_user_id, event_type, payload, created_at
      `,
      [
        organizationId,
        channelScope?.channelId ?? null,
        userScope?.userId ?? null,
        message.event,
        JSON.stringify(message),
      ],
    )

    await this.pruneOldRealtimeEvents()

    return mapRealtimeEventRow(result.rows[0]!)
  }

  /**
   * Persist-then-notify, mirroring `publishSse`: the row lands in
   * `realtime_events` first, then the NOTIFY carries its id so every
   * listener fans out against the same sequence. A custom `persistEvent`
   * seam exists only for callers that must insert through a different path
   * (e.g. a Prisma transaction); it must still insert exactly once.
   */
  async publishWs(
    scopes: WsScope[],
    input: {
      data: unknown
      event: string
      persistEvent?: PersistedRealtimeEventWriter
      ts?: string
    },
  ): Promise<WsEventMessage> {
    const message = WsEventSchema.parse({
      type: 'event',
      event: input.event,
      data: input.data,
      ts: input.ts ?? new Date().toISOString(),
    })

    const persistEvent = input.persistEvent
      ?? ((eventInput: { message: WsEventMessage; scopes: WsScope[] }) =>
        this.appendWsEvent(eventInput.scopes, eventInput.message))
    const replayEvent = await persistEvent({ message, scopes })

    await notify(this.pool, this.channel, {
      ...(replayEvent ? { eventId: replayEvent.id.toString() } : {}),
      kind: 'ws',
      message,
      scopes,
    })

    return message
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
