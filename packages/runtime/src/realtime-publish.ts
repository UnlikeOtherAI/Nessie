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
       *
       * The shape is not free, for the same reason a ref envelope's is not (see
       * `RealtimeNotificationEnvelope`). Nessie deploys blue-green, so for the
       * length of the swap that ships this, a replica running a build with no
       * knowledge of `'auth'` is LISTENing on the same channel and receives it;
       * that build is already deployed and cannot be given a guard. It reads
       * `kind` — not `'sse'`, so it falls through — finds no `eventId`, so it
       * builds no replay event and never reaches `message`, and then enters its
       * WebSocket loop, whose first act is `scopes.filter`. It does that in an
       * *unawaited* promise, so a TypeError there is an unhandled rejection,
       * which terminates the process on Node 22. Logging out is not a rare
       * event: without the field below, the first person to sign out during the
       * swap would kill every old replica holding a socket, and the admin
       * always holds one.
       */
      kind: 'auth'
      sessionId: string
      /**
       * Always empty — the same compatibility shim the ref envelopes carry, and
       * the only field a listener that predates `'auth'` dereferences without
       * checking on the path an unknown kind takes. It makes that listener's
       * WebSocket loop filter an empty array, match no connection and send
       * nothing, rather than throw. Nothing is lost: this build's fan-out
       * answers the `auth` branch and returns long before that loop. Do not
       * remove until every deployed replica understands `kind: 'auth'`.
       */
      scopes: []
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

/**
 * One page of user-lane replay, and whether it is the whole of it.
 *
 * `truncated` is the gap signal (horizontal-scaling audit 2.9). The cap used to
 * be applied silently, and a silent cap is worse than a small one: the client
 * moves its `Last-Event-ID` to the last row it received and believes it has
 * caught up, while the connection stays open and every later live event carries
 * the watermark further past the events the cap withheld. Replay cannot bring
 * those back afterwards — it is `id > watermark` — so the only recovery is for
 * the client to re-read state over REST, and it can only choose to do that if
 * it is told.
 */
export type RealtimeReplayPage = {
  events: RealtimeReplayEvent[]
  truncated: boolean
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

/**
 * Announce a publication that has **no durable row**: an ephemeral thread
 * event, a ws publication whose scopes name no organization, the cross-replica
 * session revocation.
 *
 * It goes through the same size guard as a durable publish, because the cap is
 * a property of `pg_notify` and not of the lane using it. What differs is the
 * fallback: there is no row to announce by id, so an oversized rowless payload
 * is dropped rather than raised. Dropping is the outcome these lanes are
 * already built for — an ephemeral document delta is dropped under
 * backpressure too and the client rebuilds from
 * `GET /api/threads/:threadId/document-streams/:sessionId`, and a revocation
 * converges on its cache TTL. Raising is the outcome none of them are built
 * for: it fails the caller's operation (audit 2.7 is exactly that failure on
 * the durable lane) over an announcement that was never the authority.
 */
export const notifyRealtime = async (
  pool: Pool,
  channel: string,
  payload: RealtimeNotificationPayload,
): Promise<void> => {
  await notifyEnvelope(pool, channel, payload)
}

/**
 * Postgres caps a NOTIFY payload at 8000 bytes and raises above it. Inside this
 * transaction that raise would take the INSERT down with it — and `stream.done`
 * carries the whole assistant reply, which has no bound (horizontal-scaling
 * audit 2.7), so it is reachable in ordinary use. Before the publish became one
 * transaction the row was already committed when the notify threw, so the
 * caller's operation still succeeded and the content stayed reachable — on the
 * thread lane, because the message is a durable row a REST bootstrap re-reads.
 * Not by reconnect replay: replay is `id > watermark`, so the first later event
 * delivered on that connection carries the watermark past the one that was
 * never announced. Losing the row instead would be a straight regression.
 *
 * So the payload is measured first — in bytes, because the cap is bytes and a
 * reply full of non-ASCII counts for more than its length — and an oversized
 * one is announced by row id alone. The row commits either way and the listener
 * re-reads it (`resolveRealtimeNotification`). The margin below 8000 leaves the
 * compact envelope room and keeps the check clear of the terminator Postgres
 * counts for itself.
 *
 * The same cap binds the rowless lanes, which have no ref form to fall back to
 * — `notifyRealtime` says what each of those recovers by instead.
 */
export const NOTIFY_PAYLOAD_LIMIT_BYTES = 7_000

/**
 * Anything that can run one parameterised statement: a `Pool` or a `PoolClient`
 * already inside a transaction. Named structurally because the cap check is the
 * same either way and only the caller knows which door it is holding.
 */
type NotifyQuerier = {
  query: (sql: string, values: unknown[]) => Promise<unknown>
}

/**
 * The one door to `pg_notify` for every realtime lane, durable or not, so the
 * cap is measured in exactly one place.
 *
 * `compact` is the ref form when the caller has a committed row to point at,
 * and absent when it has none. Both fall back to sending nothing rather than
 * raising — see `notifyWithinTransaction` and `notifyRealtime` for what each
 * lane recovers by instead.
 */
const notifyEnvelope = async (
  querier: NotifyQuerier,
  channel: string,
  payload: RealtimeNotificationEnvelope,
  compact?: () => RealtimeNotificationEnvelope,
): Promise<void> => {
  const full = JSON.stringify(payload)
  const body =
    Buffer.byteLength(full, 'utf8') <= NOTIFY_PAYLOAD_LIMIT_BYTES || !compact
      ? full
      : JSON.stringify(compact())

  if (Buffer.byteLength(body, 'utf8') > NOTIFY_PAYLOAD_LIMIT_BYTES) {
    // With a row: not reachable unless the scope list alone is enormous, and
    // the row is committed regardless — so stay silent rather than raise and
    // destroy it. No connection is told, and reconnect replay returns the event
    // only while no later event has carried that connection's watermark past it
    // (`id > watermark`). What does recover the content is the durable row
    // itself: on the thread lane a REST bootstrap re-reads the message. The
    // WebSocket lane has no such re-read, so there the live event is simply
    // missed.
    //
    // Without a row there is nothing to announce by id at all, which is why
    // this is a log rather than a silent return: the lane's own recovery (a
    // document-stream bootstrap, a cache TTL) is what closes it, and an
    // operator has no other way to learn the announcement never went out.
    console.warn(
      '[realtime] notification over the pg_notify cap was dropped',
      { bytes: Buffer.byteLength(body, 'utf8'), kind: payload.kind, refForm: Boolean(compact) },
    )
    return
  }

  await querier.query('SELECT pg_notify($1, $2)', [channel, body])
}

export const notifyWithinTransaction = async (
  client: PoolClient,
  channel: string,
  payload: RealtimeNotificationEnvelope,
  compact: () => RealtimeNotificationEnvelope,
): Promise<void> => {
  await notifyEnvelope(client, channel, payload, compact)
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
