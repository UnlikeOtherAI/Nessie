// `thread_stream_events` retention (horizontal-scaling audit 2.3, overview row
// 5.4).
//
// `realtime_events` has been pruned to 24 hours for a while; the thread lane's
// log was never pruned at all, and it is the larger of the two by orders of
// magnitude — a row per streamed token. It now rides the same sweep rather than
// getting one of its own: the same window, the same cluster-wide cadence row
// and the same `withSweepLock` leader, because two policies over the same kind
// of data are two things to drift apart.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Pool } from 'pg'
import { parseOrganizationId, parseUserId, type WsScope } from '@nessie/schemas'

import { PgRealtimeTransport } from '../src/realtime.js'

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; threadId: string }

const seedTenant = async (pool: Pool): Promise<Seed> => {
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const channelId = randomUUID()
  const threadId = randomUUID()

  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, 'Thread event retention', now(), now())`,
    [organizationId],
  )
  await pool.query(
    `INSERT INTO projects (id, name, organization_id, created_at, updated_at)
     VALUES ($1, 'Thread event retention', $2, now(), now())`,
    [projectId, organizationId],
  )
  await pool.query(
    `INSERT INTO teams (id, name, project_id, created_at, updated_at)
     VALUES ($1, 'Thread event retention', $2, now(), now())`,
    [teamId, projectId],
  )
  await pool.query(
    `INSERT INTO channels (
       id, label, slug, organization_id, project_id, team_id, created_at, updated_at
     )
     VALUES ($1, 'Thread event retention', $2, $3, $4, $5, now(), now())`,
    [channelId, `thread-retention-${channelId}`, organizationId, projectId, teamId],
  )
  await pool.query(
    `INSERT INTO threads (id, channel_id, created_at, updated_at) VALUES ($1, $2, now(), now())`,
    [threadId, channelId],
  )
  return { organizationId, threadId }
}

const insertThreadEvent = async (
  pool: Pool,
  input: { age: string; threadId: string },
): Promise<string> => {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO thread_stream_events (thread_id, event_name, data, created_at)
     VALUES ($1, 'stream.done', '{}'::jsonb, now() - $2::interval)
     RETURNING id`,
    [input.threadId, input.age],
  )
  return inserted.rows[0]!.id
}

const stillThere = async (pool: Pool, id: string): Promise<boolean> => {
  const row = await pool.query('SELECT 1 FROM thread_stream_events WHERE id = $1', [id])
  return row.rowCount === 1
}

runIfDatabase('the thread stream log is retained on the same window as realtime_events', async () => {
  const connectionString = process.env.DATABASE_URL!
  const channel = `nessie_realtime_test_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString, max: 5 })
  const seed = await seedTenant(pool)

  const scopes: WsScope[] = [
    { kind: 'organization', organizationId: parseOrganizationId(seed.organizationId) },
    {
      kind: 'user',
      organizationId: parseOrganizationId(seed.organizationId),
      userId: parseUserId(randomUUID()),
    },
  ]

  try {
    const outsideWindow = await insertThreadEvent(pool, { age: '25 hours', threadId: seed.threadId })
    const insideWindow = await insertThreadEvent(pool, { age: '23 hours', threadId: seed.threadId })
    const realtimeOutsideWindow = await pool.query<{ id: string }>(
      `INSERT INTO realtime_events (organization_id, event_type, payload, created_at)
       VALUES ($1, 'test.retention', '{}'::jsonb, now() - '25 hours'::interval)
       RETURNING id`,
      [seed.organizationId],
    )

    // The cadence is cluster-wide, so a peer suite may have just claimed this
    // minute. Clear it and publish through a fresh transport (whose in-process
    // pre-filter starts open) until the sweep has actually run — inferring it
    // from a missing row would let a peer's prune stand in for this one.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!(await stillThere(pool, outsideWindow))) {
        break
      }
      await pool.query('DELETE FROM realtime_prune_state')
      await new PgRealtimeTransport(pool, connectionString, channel).publishWs(scopes, {
        data: { rootMessageId: randomUUID(), threadId: randomUUID() },
        event: 'thread.read',
      })
    }

    assert.equal(
      await stillThere(pool, outsideWindow),
      false,
      'a thread stream event past retention must go — it was never pruned at all before',
    )
    assert.equal(
      await stillThere(pool, insideWindow),
      true,
      'and one inside the window must survive, so a reconnect inside it replays no gap',
    )

    // One claim, both lanes: a sweep that pruned one and not the other would be
    // the second policy this deliberately does not introduce.
    const realtimeRow = await pool.query('SELECT 1 FROM realtime_events WHERE id = $1', [
      realtimeOutsideWindow.rows[0]!.id,
    ])
    assert.equal(
      realtimeRow.rowCount,
      0,
      'the same tick must prune realtime_events too, or the two windows can drift',
    )
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [seed.organizationId])
    await pool.end()
  }
})
