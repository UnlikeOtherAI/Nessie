import type { Pool, PoolClient } from 'pg'
import { SseEventSchema, type SseEvent, type WsScope } from '@nessie/schemas'

export type ThreadStreamEventRow = {
  created_at: Date
  data: unknown
  event_name: SseEvent['event']
  // `thread_stream_events.id` is `bigint`, and node-postgres hands `int8` back
  // as a *string* — there is no global type parser for it. `mapThreadStreamEvent`
  // is the one place that converts, and it must: the hub compares
  // `connection.lastSequence >= notification.sequence` and then assigns the
  // arriving value into the watermark, so a string on either side turns the
  // comparison lexicographic — `'999999' >= '1000000'` is true, and the stream
  // stalls at every power of ten until the client reconnects.
  id: string
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

export type RealtimeReplayEvent = {
  id: bigint
  channelId: string | null
  eventType: string
  payload: unknown
  createdAt: Date
  recipientUserId: string | null
}

export type RealtimeEventRow = {
  id: bigint | number
  organization_id: string
  channel_id: string | null
  recipient_user_id: string | null
  event_type: string
  payload: unknown
  created_at: Date
}

export const mapThreadStreamEvent = (row: ThreadStreamEventRow): ThreadStreamEvent => ({
  data: SseEventSchema.parse({
    event: row.event_name,
    data: row.data,
  }).data,
  event: row.event_name,
  sequence: Number(row.id),
  threadId: row.thread_id,
  ts: row.created_at.toISOString(),
})

export const mapRealtimeEventRow = (row: RealtimeEventRow): RealtimeReplayEvent => ({
  id: BigInt(row.id),
  channelId: row.channel_id,
  eventType: row.event_type,
  payload: row.payload,
  createdAt: row.created_at,
  recipientUserId: row.recipient_user_id,
})

export const notifyRealtime = async (
  pool: Pool,
  channel: string,
  payload: RealtimeNotificationPayload,
): Promise<void> => {
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)])
}

/**
 * Run one durable publish so that **id order equals commit order** for every
 * event a connection watermark covers.
 *
 * A transaction alone is not enough. Postgres delivers notifications in
 * *commit* order, but `id`/`sequence` come from a sequence at *insert* time,
 * so two concurrent transactions can still commit in the opposite order of
 * their ids: the listener then sees the higher id first, advances the
 * per-connection watermark past the lower one, and drops it permanently —
 * the client's `Last-Event-ID` has moved on, so replay (`id > $2`) never
 * returns it either.
 *
 * Holding a per-scope advisory lock from *before* the INSERT until COMMIT
 * serialises the publishers that share a watermark, so within that scope the
 * sequence is handed out and committed in the same order. `pg_advisory_xact_lock`
 * is released by the COMMIT or ROLLBACK itself, so a crashed publisher cannot
 * wedge the scope. The lock is per scope, not global: threads and organizations
 * publish concurrently, only the publishers a single watermark spans wait.
 */
const withOrderedPublish = async <T>(
  pool: Pool,
  lockScope: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockScope])
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Insert the `thread_stream_events` row and NOTIFY its arrival in one
 * transaction, serialised per thread — the scope a thread SSE connection's
 * `lastSequence` watermark spans.
 */
export const publishThreadStreamEvent = async (
  pool: Pool,
  channel: string,
  input: {
    data: SseEvent['data']
    event: SseEvent['event']
    threadId: string
  },
): Promise<ThreadStreamEvent> => {
  const parsed = SseEventSchema.parse({ event: input.event, data: input.data })

  return withOrderedPublish(pool, `realtime:thread:${input.threadId}`, async (client) => {
    const result = await client.query<ThreadStreamEventRow>(
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
      [input.threadId, parsed.event, JSON.stringify(parsed.data)],
    )

    const record = mapThreadStreamEvent(result.rows[0]!)
    await client.query('SELECT pg_notify($1, $2)', [
      channel,
      JSON.stringify({ kind: 'sse', ...record } satisfies RealtimeNotificationPayload),
    ])
    return record
  })
}

const findScope = <TKind extends WsScope['kind']>(
  scopes: WsScope[],
  kind: TKind,
): Extract<WsScope, { kind: TKind }> | undefined =>
  scopes.find((scope): scope is Extract<WsScope, { kind: TKind }> => scope.kind === kind)

/**
 * The organization whose `realtime_events` sequence this publication belongs
 * to, or `null` when it has no deliverable target (neither a channel nor a
 * user scope) or the organization cannot be resolved. A `null` means no
 * durable row and therefore no watermark, so such a publication needs no lock
 * and is notified outside a transaction.
 */
const resolveWsOrganizationId = async (
  pool: Pool,
  scopes: WsScope[],
): Promise<string | null> => {
  const channelScope = findScope(scopes, 'channel')
  const userScope = findScope(scopes, 'user')
  if (!channelScope && !userScope) {
    return null
  }

  // A user-scoped publication (the incoming-call ring) carries neither an
  // organization nor a channel scope, but the user scope names its own
  // organization. Without this fallback no row would be written, and the hub
  // gates the whole user-SSE fan-out on a persisted row.
  const organizationId = findScope(scopes, 'organization')?.organizationId ?? null
  if (organizationId) {
    return organizationId
  }

  if (channelScope) {
    const channel = await pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM channels WHERE id = $1',
      [channelScope.channelId],
    )
    const resolved = channel.rows[0]?.organization_id ?? null
    if (resolved) {
      return resolved
    }
  }

  return userScope?.organizationId ?? null
}

/**
 * Insert the `realtime_events` row and NOTIFY its arrival in one transaction,
 * serialised per organization — the scope a user SSE connection's
 * `lastEventId` watermark spans (`listRealtimeEventsAfterCursor` replays one
 * organization's events for one user).
 *
 * The transport is the only writer. A listener must never append: with N api
 * replicas that wrote N copies of the same event and duplicated every replay.
 */
export const publishWsEvent = async (
  pool: Pool,
  channel: string,
  input: {
    message: WsEventMessage
    scopes: WsScope[]
  },
): Promise<RealtimeReplayEvent | null> => {
  const organizationId = await resolveWsOrganizationId(pool, input.scopes)
  if (!organizationId) {
    await notifyRealtime(pool, channel, {
      kind: 'ws',
      message: input.message,
      scopes: input.scopes,
    })
    return null
  }

  const channelScope = findScope(input.scopes, 'channel')
  const userScope = findScope(input.scopes, 'user')

  return withOrderedPublish(pool, `realtime:org:${organizationId}`, async (client) => {
    const result = await client.query<RealtimeEventRow>(
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
        input.message.event,
        JSON.stringify(input.message),
      ],
    )

    const replayEvent = mapRealtimeEventRow(result.rows[0]!)
    await client.query('SELECT pg_notify($1, $2)', [
      channel,
      JSON.stringify({
        eventId: replayEvent.id.toString(),
        kind: 'ws',
        message: input.message,
        scopes: input.scopes,
      } satisfies RealtimeNotificationPayload),
    ])
    return replayEvent
  })
}
