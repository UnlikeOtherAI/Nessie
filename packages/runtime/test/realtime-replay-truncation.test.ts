// The replay cap, and why it may not be silent (horizontal-scaling audit 2.9,
// overview row 5.4).
//
// `listRealtimeEventsAfterCursor` returns at most `MAX_REPLAY_EVENTS` rows. On
// its own that is a reasonable bound; the defect was that it said nothing when
// it applied. The client then advances `Last-Event-ID` to the last row it
// received and believes it has caught up, while the events the cap withheld are
// carried past by every live event that follows — replay is `id > watermark`,
// so a later reconnect cannot return them either. The only recovery is a REST
// re-read, and the client can only choose it if it is told.
//
// Postgres-backed, because "did this page end because the cap cut it, or
// because there was nothing more?" is a question about the query.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Pool } from 'pg'

import { listRealtimeEventsAfterCursor } from '../src/realtime.js'

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

// Must match `MAX_REPLAY_EVENTS` in `packages/runtime/src/realtime.ts`. A test
// that read the constant from the module could not tell a cap of 5000 from a
// cap of zero; this one fails loudly if the two drift apart.
const MAX_REPLAY_EVENTS = 5_000

const seedOrganization = async (pool: Pool): Promise<string> => {
  const organizationId = randomUUID()
  await pool.query(
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES ($1, 'Realtime replay truncation', now(), now())`,
    [organizationId],
  )
  return organizationId
}

/** One statement, because the point of the test is a page bigger than the cap. */
const seedEvents = async (
  pool: Pool,
  input: { count: number; organizationId: string; userId: string },
): Promise<void> => {
  await pool.query(
    `INSERT INTO realtime_events (
       organization_id, channel_id, recipient_user_id, event_type, payload, created_at
     )
     SELECT $1, NULL, $2, 'test.replay', jsonb_build_object('n', n), now()
     FROM generate_series(1, $3) AS n`,
    [input.organizationId, input.userId, input.count],
  )
}

const replay = (pool: Pool, input: { organizationId: string; userId: string }) =>
  listRealtimeEventsAfterCursor(pool, {
    afterEventId: 0n,
    channelIds: [],
    organizationId: input.organizationId,
    userId: input.userId,
  })

runIfDatabase('a replay that fits reports no gap', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 5 })
  const organizationId = await seedOrganization(pool)
  const userId = randomUUID()

  try {
    await seedEvents(pool, { count: 10, organizationId, userId })
    const page = await replay(pool, { organizationId, userId })

    assert.equal(page.events.length, 10)
    assert.equal(page.truncated, false, 'a complete replay must not cry gap')
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})

runIfDatabase('a replay that ends exactly on the cap still reports no gap', async () => {
  // The boundary is the whole reason the query asks for `MAX + 1`: counting the
  // returned rows cannot tell a page that ended *on* the cap from one that was
  // cut *by* it, and guessing either way is a false signal — a spurious gap
  // costs every client a full re-read, a missed one is the defect.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 5 })
  const organizationId = await seedOrganization(pool)
  const userId = randomUUID()

  try {
    await seedEvents(pool, { count: MAX_REPLAY_EVENTS, organizationId, userId })
    const page = await replay(pool, { organizationId, userId })

    assert.equal(page.events.length, MAX_REPLAY_EVENTS)
    assert.equal(page.truncated, false, 'exactly the cap is a complete replay')
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})

runIfDatabase('a replay the cap cuts short reports the gap, and still returns the cap', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 5 })
  const organizationId = await seedOrganization(pool)
  const userId = randomUUID()

  try {
    await seedEvents(pool, { count: MAX_REPLAY_EVENTS + 25, organizationId, userId })
    const page = await replay(pool, { organizationId, userId })

    assert.equal(
      page.events.length,
      MAX_REPLAY_EVENTS,
      'the cap still binds — the extra row is asked for to be counted, never delivered',
    )
    assert.equal(page.truncated, true, 'and the client is told it is behind')

    const ids = page.events.map((event) => event.id)
    assert.deepEqual(
      [...ids].sort((left, right) => (left < right ? -1 : 1)),
      ids,
      'oldest first, so the watermark it leaves behind is the oldest unread point',
    )
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})
