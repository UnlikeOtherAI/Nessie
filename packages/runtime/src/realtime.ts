import type { ClientConfig, Notification, Pool } from 'pg'
import { Client } from 'pg'
import { withSweepLock } from '@nessie/db'
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

/**
 * The retention sweep's cluster-wide identity. Stable by contract: renaming it
 * during a rolling deploy is the same as taking no lock at all.
 */
const REALTIME_PRUNE_LOCK = 'realtime-events-prune'
/** Single row; the table exists only to hold this one cadence. */
const REALTIME_PRUNE_STATE_ID = 'realtime_events'

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

  /**
   * Delete `realtime_events` past retention, once a minute for the whole
   * cluster.
   *
   * Two guards, because they answer different questions (horizontal-scaling
   * invariant 2, audit 2.3). `withSweepLock` answers *who*: the DELETE has no
   * index on `created_at` alone, so it is a sequential scan, and two replicas
   * running it at once is the contention worth avoiding. The
   * `realtime_prune_state` row answers *whether it is due*, and it has to be a
   * row rather than the field it replaced: `lastPruneAt` was per process, so
   * the "once a minute" was really once a minute *per replica*, and it reset
   * to zero on every restart. The clock is read from `now()` on the server for
   * the same reason — replica clocks are not the cluster's clock.
   *
   * The claim is a single conditional upsert: it returns a row only when it
   * moved the watermark, which is also what creates the row the first time.
   * It sits inside the lock rather than in front of it, so the cost on the
   * publish path is the lock probe — a `BEGIN`/`SELECT`/`ROLLBACK` on one
   * pooled client, held for about a millisecond — rather than a free
   * in-memory comparison. That is the price of a cadence a second instance
   * can see, and it is small beside the INSERT and NOTIFY it follows.
   */
  private async pruneOldRealtimeEvents(): Promise<void> {
    await withSweepLock(this.pool, REALTIME_PRUNE_LOCK, async () => {
      const claimed = await this.pool.query(
        `
          INSERT INTO realtime_prune_state (id, pruned_at)
          VALUES ($1, now())
          ON CONFLICT (id) DO UPDATE SET pruned_at = now()
            WHERE realtime_prune_state.pruned_at < now() - make_interval(secs => $2)
          RETURNING pruned_at
        `,
        [REALTIME_PRUNE_STATE_ID, REALTIME_EVENT_PRUNE_INTERVAL_MS / 1000],
      )
      if (claimed.rowCount === 0) {
        return
      }

      await this.pool.query(
        'DELETE FROM realtime_events WHERE created_at < $1',
        [new Date(Date.now() - REALTIME_EVENT_RETENTION_MS)],
      )
    })
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
   *
   * `scopes: []` is a deploy-compatibility field, not payload data: it is what
   * keeps a replica on the previous build from crashing on this payload during
   * a blue-green swap. See `RealtimeNotificationPayload`.
   */
  async publishSessionRevocation(sessionId: string): Promise<void> {
    await notifyRealtime(this.pool, this.channel, { kind: 'auth', scopes: [], sessionId })
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
