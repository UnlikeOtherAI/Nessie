import { isDeepStrictEqual } from 'node:util'

import type { Pool, PoolClient } from 'pg'
import { SseEventSchema, type SseEvent, type WsScope } from '@nessie/schemas'

import {
  buildSseRefEnvelope,
  buildWsRefEnvelope,
  mapRealtimeEventRow,
  mapThreadStreamEvent,
  notifyRealtime,
  notifyWithinTransaction,
  type RealtimeEventRow,
  type RealtimeReplayEvent,
  type ThreadStreamEvent,
  type ThreadStreamEventRow,
  type WsEventMessage,
} from './realtime-publish.js'

/**
 * Run one durable publish so id order equals commit order for every event a
 * connection watermark covers. The advisory lock is acquired before INSERT
 * and held through COMMIT, scoped to one thread or organization.
 */
const withOrderedPublish = async <T>(
  pool: Pool,
  lockScope: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect()
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

/** Persist and announce a thread event exactly once under a stable key. */
export const publishThreadStreamEvent = async (
  pool: Pool,
  channel: string,
  input: {
    data: SseEvent['data']
    event: SseEvent['event']
    idempotencyKey?: string
    threadId: string
  },
): Promise<ThreadStreamEvent> => {
  const parsed = SseEventSchema.parse({ event: input.event, data: input.data })
  const persistedData = JSON.parse(JSON.stringify(parsed.data)) as SseEvent['data']

  return withOrderedPublish(pool, `realtime:thread:${input.threadId}`, async (client) => {
    const result = await client.query<ThreadStreamEventRow>(
      `
        INSERT INTO thread_stream_events (
          thread_id, event_name, data, created_at, idempotency_key
        )
        VALUES ($1, $2, $3::jsonb, now(), $4)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id, thread_id, event_name, data, created_at
      `,
      [input.threadId, parsed.event, JSON.stringify(persistedData), input.idempotencyKey ?? null],
    )
    const inserted = result.rows[0]
    const row = inserted ?? (await client.query<ThreadStreamEventRow>(
      `SELECT id, thread_id, event_name, data, created_at
       FROM thread_stream_events WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    )).rows[0]
    if (!row) throw new Error('thread stream event idempotency lookup failed')
    if (
      !inserted
      && (
        row.thread_id !== input.threadId
        || row.event_name !== parsed.event
        || !isDeepStrictEqual(row.data, persistedData)
      )
    ) {
      throw new Error('thread stream event idempotency key reused for another event')
    }
    const record = mapThreadStreamEvent(row)
    if (!inserted) return record
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

const resolveWsOrganizationId = async (
  pool: Pool,
  scopes: WsScope[],
): Promise<string | null> => {
  const channelScope = findScope(scopes, 'channel')
  const userScope = findScope(scopes, 'user')
  if (!channelScope && !userScope) return null

  const organizationId = findScope(scopes, 'organization')?.organizationId ?? null
  if (organizationId) return organizationId

  if (channelScope) {
    const channel = await pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM channels WHERE id = $1',
      [channelScope.channelId],
    )
    const resolved = channel.rows[0]?.organization_id ?? null
    if (resolved) return resolved
  }

  return userScope?.organizationId ?? null
}

/** Persist and announce an audience-scoped websocket event exactly once. */
export const publishWsEvent = async (
  pool: Pool,
  channel: string,
  input: {
    idempotencyKey?: string
    message: WsEventMessage
    scopes: WsScope[]
  },
): Promise<RealtimeReplayEvent | null> => {
  // PostgreSQL stores the JSON representation, where object properties whose
  // value is undefined do not exist. Compare retries to exactly that shape so
  // a semantic replay is accepted without weakening different-payload checks.
  const persistedMessage = JSON.parse(JSON.stringify(input.message)) as WsEventMessage
  const organizationId = await resolveWsOrganizationId(pool, input.scopes)
  if (!organizationId) {
    await notifyRealtime(pool, channel, {
      kind: 'ws',
      message: persistedMessage,
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
          organization_id, channel_id, recipient_user_id,
          event_type, payload, created_at, idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, now(), $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id, organization_id, channel_id, recipient_user_id, event_type, payload, created_at
      `,
      [
        organizationId,
        channelScope?.channelId ?? null,
        userScope?.userId ?? null,
        input.message.event,
        JSON.stringify(persistedMessage),
        input.idempotencyKey ?? null,
      ],
    )
    const inserted = result.rows[0]
    const row = inserted ?? (await client.query<RealtimeEventRow>(
      `SELECT id, organization_id, channel_id, recipient_user_id, event_type, payload, created_at
       FROM realtime_events WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    )).rows[0]
    if (!row) throw new Error('realtime event idempotency lookup failed')
    if (
      !inserted
      && (
        row.organization_id !== organizationId
        || row.channel_id !== (channelScope?.channelId ?? null)
        || row.recipient_user_id !== (userScope?.userId ?? null)
        || row.event_type !== input.message.event
        || !isDeepStrictEqual(row.payload, persistedMessage)
      )
    ) {
      throw new Error('realtime event idempotency key reused for another audience or event')
    }
    const replayEvent = mapRealtimeEventRow(row)
    if (!inserted) return replayEvent
    await notifyWithinTransaction(
      client,
      channel,
      {
        eventId: replayEvent.id.toString(),
        kind: 'ws',
        message: persistedMessage,
        scopes: input.scopes,
      },
      () => buildWsRefEnvelope({ eventId: replayEvent.id.toString(), scopes: input.scopes }),
    )
    return replayEvent
  })
}
