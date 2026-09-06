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
  | {
      /**
       * A control message between replicas, never delivered to a client: the
       * replica that revoked a login session tells the others to drop that
       * `sid` from their revocation caches at once, instead of each waiting
       * out its own TTL. Nothing is persisted — a replica that was not
       * listening converges on its TTL, which stays the backstop.
       */
      kind: 'auth'
      sessionId: string
    }

/**
 * What actually travels over NOTIFY. A `*-ref` variant carries the row id in
 * place of the payload; `resolveRealtimeNotification` reads the row back and
 * hands a plain `RealtimeNotificationPayload` to the fan-out, so nothing above
 * the transport ever meets one. See `notifyWithinTransaction` for why an
 * oversized payload has to be announced this way rather than raise.
 *
 * The shape of a ref envelope is not free. Nessie deploys blue-green, so for
 * the length of a swap a replica running the *previous* build is LISTENing on
 * the same channel and receives these. That build parses any valid JSON and
 * hands the result straight to its fan-out, which reads three fields without
 * checking them: `kind`; then `eventId`, and if that is a string it immediately
 * dereferences `message`; then, for every WebSocket connection, `scopes.filter`.
 * It does that work in an *unawaited* promise, so a TypeError there is an
 * unhandled rejection, which terminates the process on Node 22 — one long
 * assistant reply from a new replica would kill every old replica holding a
 * socket, and the admin always holds one.
 *
 * A ref envelope is therefore built to be **inert** to that build rather than
 * to rely on it being tolerant; it is already deployed and cannot be changed.
 *   - Everything the ref form actually carries lives under `ref`, a key the old
 *     fan-out never reads. It finds no `eventId`, so it builds no replay event
 *     and never reaches `message`.
 *   - `scopes` is present and empty, so the WebSocket loop it does reach
 *     filters an empty array, matches no connection and sends nothing.
 * Nothing is lost for those clients: the row is committed, and their next
 * reconnect replays it. Neither `ref` nor the empty `scopes` may be flattened
 * or dropped until every deployed replica understands the ref form.
 */
export type RealtimeNotificationEnvelope =
  | RealtimeNotificationPayload
  | {
      kind: 'sse-ref'
      ref: {
        /** `thread_stream_events.id` of the row to re-read. */
        sequence: number
        threadId: string
      }
      /** Always empty — the compatibility shim described above. */
      scopes: []
    }
  | {
      kind: 'ws-ref'
      ref: {
        /** `realtime_events.id` of the row to re-read. */
        eventId: string
        /**
         * Delivery scopes are not a column on `realtime_events` — only
         * `channel_id` and `recipient_user_id` are, which cannot express an agent
         * or dashboard scope — so they ride the notification even in the compact
         * form. They are a handful of ids, orders of magnitude below the payload
         * the compact form exists to leave behind.
         */
        scopes: WsScope[]
      }
      /** Always empty — the compatibility shim described above. */
      scopes: []
    }

/**
 * The only two places a ref envelope is constructed, so the compatibility shim
 * above cannot be forgotten at one call site and present at another.
 */
export const buildSseRefEnvelope = (input: {
  sequence: number
  threadId: string
}): RealtimeNotificationEnvelope => ({
  kind: 'sse-ref',
  ref: { sequence: input.sequence, threadId: input.threadId },
  scopes: [],
})

export const buildWsRefEnvelope = (input: {
  eventId: string
  scopes: WsScope[]
}): RealtimeNotificationEnvelope => ({
  kind: 'ws-ref',
  ref: { eventId: input.eventId, scopes: input.scopes },
  scopes: [],
})

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
  // node-postgres does not roll a transaction back when a client is released.
  // So if the ROLLBACK itself fails while the connection survives — the server
  // refused the command, a blip landed mid-statement — a plain `release()`
  // would hand the next borrower a client still inside this transaction: its
  // statements would run in it, still holding this scope's advisory lock, and
  // be thrown away by whatever rolls back next. Releasing *with* an error is
  // the only way to be sure the transaction is gone: the pool destroys that
  // connection instead of reusing it.
  let destroyReason: Error | undefined
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockScope])
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      destroyReason =
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
    }
    throw error
  } finally {
    client.release(destroyReason)
  }
}

/**
 * Postgres caps a NOTIFY payload at 8000 bytes and raises above it. Inside this
 * transaction that raise would take the INSERT down with it — and `stream.done`
 * carries the whole assistant reply, which has no bound (horizontal-scaling
 * audit 2.7), so it is reachable in ordinary use. Before the publish became one
 * transaction the row was already committed when the notify threw, and the
 * client recovered the event on its next reconnect replay: late, but never
 * lost, and the caller's operation still succeeded. Losing the row instead
 * would be a straight regression.
 *
 * So the payload is measured first — in bytes, because the cap is bytes and a
 * reply full of non-ASCII counts for more than its length — and an oversized
 * one is announced by row id alone. The row commits either way and the listener
 * re-reads it (`resolveRealtimeNotification`). The margin below 8000 leaves the
 * compact envelope room and keeps the check clear of the terminator Postgres
 * counts for itself.
 */
const NOTIFY_PAYLOAD_LIMIT_BYTES = 7_000

const notifyWithinTransaction = async (
  client: PoolClient,
  channel: string,
  payload: RealtimeNotificationEnvelope,
  compact: () => RealtimeNotificationEnvelope,
): Promise<void> => {
  const full = JSON.stringify(payload)
  const body =
    Buffer.byteLength(full, 'utf8') <= NOTIFY_PAYLOAD_LIMIT_BYTES
      ? full
      : JSON.stringify(compact())

  if (Buffer.byteLength(body, 'utf8') > NOTIFY_PAYLOAD_LIMIT_BYTES) {
    // Not reachable unless the scope list alone is enormous, and the row is
    // committed regardless — so stay silent rather than raise and destroy it.
    // The client still recovers the event from replay on its next reconnect.
    return
  }

  await client.query('SELECT pg_notify($1, $2)', [channel, body])
}

/**
 * Turn what arrived on the wire back into a payload the fan-out understands,
 * reading the row when only its id travelled. `null` means the row is gone —
 * pruned, or its transaction rolled back after the notify was already queued —
 * and there is nothing to deliver.
 */
export const resolveRealtimeNotification = async (
  pool: Pool,
  envelope: RealtimeNotificationEnvelope,
): Promise<RealtimeNotificationPayload | null> => {
  if (envelope.kind === 'sse-ref') {
    const result = await pool.query<ThreadStreamEventRow>(
      `
        SELECT id, thread_id, event_name, data, created_at
        FROM thread_stream_events
        WHERE id = $1::bigint
      `,
      [envelope.ref.sequence],
    )
    const row = result.rows[0]
    return row ? { kind: 'sse', ...mapThreadStreamEvent(row) } : null
  }

  if (envelope.kind === 'ws-ref') {
    const result = await pool.query<RealtimeEventRow>(
      `
        SELECT id, organization_id, channel_id, recipient_user_id, event_type, payload, created_at
        FROM realtime_events
        WHERE id = $1::bigint
      `,
      [envelope.ref.eventId],
    )
    const row = result.rows[0]
    return row
      ? {
          eventId: BigInt(row.id).toString(),
          kind: 'ws',
          message: row.payload as WsEventMessage,
          scopes: envelope.ref.scopes,
        }
      : null
  }

  return envelope
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
    await notifyWithinTransaction(
      client,
      channel,
      { kind: 'sse', ...record },
      () => buildSseRefEnvelope({ sequence: record.sequence, threadId: record.threadId }),
    )
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
    await notifyWithinTransaction(
      client,
      channel,
      {
        eventId: replayEvent.id.toString(),
        kind: 'ws',
        message: input.message,
        scopes: input.scopes,
      },
      () => buildWsRefEnvelope({ eventId: replayEvent.id.toString(), scopes: input.scopes }),
    )
    return replayEvent
  })
}
