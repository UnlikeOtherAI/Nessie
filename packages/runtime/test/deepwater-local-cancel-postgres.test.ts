import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { settleDeepWaterPersonAction } from '../src/deepwater-brief-actions.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import { cancelUnopenedDeepWaterBrief } from '../src/deepwater-local-cancel.js'
import { agentOrigin, insertBrief, personOrigin, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * A research brief DeepWater has not named yet is cancelled here (Water plan
 * amendments N8.5): once nothing can still open it in DeepWater, so an open
 * brief always has a way out before the reap gives it up a day later — and
 * never while a person's opening action, an agent's run or a watch replay may
 * be sending its opening, which would leave a paid brief no row points at.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const withFixture = (name: string, body: (fixture: BriefFixture) => Promise<void>): void => {
  runIfDatabase(name, async () => {
    const fixture = await seedBriefFixture()
    try {
      await body(fixture)
    } finally {
      await fixture.cleanup()
    }
  })
}

const cancel = (fixture: BriefFixture, runId: string, actionId: string = randomUUID()) =>
  fixture.prisma.$transaction((tx) => cancelUnopenedDeepWaterBrief(tx, {
    organizationId: fixture.ids.organization,
    runId,
    actionId,
  }))

const read = async (fixture: BriefFixture, runId: string) => {
  const run = await readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId })
  assert.ok(run)
  return run
}

/** A queue job the way the API or the watch sweep enqueues one, in the state a worker left it. */
const job = (fixture: BriefFixture, input: { topic: string; key: string; runId: string; status: string }) =>
  fixture.pool.query(
    `INSERT INTO queue_jobs (topic, payload, idempotency_key, status) VALUES ($1, $2, $3, $4)`,
    [input.topic, JSON.stringify({ organizationId: fixture.ids.organization, runId: input.runId }), input.key, input.status],
  )

withFixture('a person\'s brief is cancelled here only once its opening can no longer reach DeepWater', async (fixture) => {
  const { run } = await insertBrief(fixture, personOrigin())
  const opening = run.scopeState?.pendingAction?.actionId
  assert.ok(opening)
  const key = `deep-water-brief-action:${run.id}:${opening}`
  await job(fixture, { topic: 'deep_water.brief.action', key, runId: run.id, status: 'pending' })

  assert.equal(await cancel(fixture, run.id), 'opening', 'the opening job may still reach Ledger')
  assert.equal((await read(fixture, run.id)).status, 'queued')

  // Ledger stayed unreachable for the whole retry window: the job ended the action and finished.
  await fixture.prisma.$transaction((tx) => settleDeepWaterPersonAction(tx, {
    organizationId: fixture.ids.organization, runId: run.id, actionId: opening, errorCode: 'unavailable',
  }))
  await fixture.pool.query(`UPDATE queue_jobs SET status = 'done' WHERE idempotency_key = $1`, [key])

  const actionId = randomUUID()
  assert.equal(await cancel(fixture, run.id, actionId), 'cancelled')
  const cancelled = await read(fixture, run.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(cancelled.completedAt)
  assert.equal(cancelled.scopeState?.pendingAction, null)
  assert.equal(cancelled.externalRunId, null)

  assert.equal(await cancel(fixture, run.id, actionId), 'replay', 'a lost answer retried is a replay')
  assert.equal(await cancel(fixture, run.id), 'not_cancellable', 'a new request finds it ended')
})

withFixture('an opening whose job died is not in flight, so the brief can be cancelled', async (fixture) => {
  const { run } = await insertBrief(fixture, personOrigin())
  const opening = run.scopeState?.pendingAction?.actionId
  assert.ok(opening)
  await job(fixture, {
    topic: 'deep_water.brief.action', key: `deep-water-brief-action:${run.id}:${opening}`, runId: run.id, status: 'dead',
  })
  assert.equal(await cancel(fixture, run.id), 'cancelled')
})

withFixture('an agent\'s brief waits for its run and any watch or event replay before it is cancelled here', async (fixture) => {
  const { run } = await insertBrief(fixture, agentOrigin(fixture))
  await fixture.pool.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [fixture.ids.originRun])
  assert.equal(await cancel(fixture, run.id), 'opening', 'the agent\'s run may be sending the start')

  await fixture.pool.query(`UPDATE runs SET status = 'completed' WHERE id = $1`, [fixture.ids.originRun])
  const replay = `deep-water-watch:${run.id}:1`
  await job(fixture, { topic: 'deep_water.run.watch', key: replay, runId: run.id, status: 'processing' })
  assert.equal(await cancel(fixture, run.id), 'opening', 'a watch replay may be sending the start')

  await fixture.pool.query(`UPDATE queue_jobs SET status = 'done' WHERE idempotency_key = $1`, [replay])
  // A DeepWater event for the brief makes the watch's own read, which replays the start too.
  const event = `deep-water-event:evt_${randomUUID().replaceAll('-', '')}`
  await job(fixture, { topic: 'deep_water.research.event', key: event, runId: run.id, status: 'pending' })
  assert.equal(await cancel(fixture, run.id), 'opening', 'an event\'s read may be sending the start')

  await fixture.pool.query(`UPDATE queue_jobs SET status = 'done' WHERE idempotency_key = $1`, [event])
  assert.equal(await cancel(fixture, run.id), 'cancelled')
  assert.equal((await read(fixture, run.id)).status, 'cancelled')
})

withFixture('a brief DeepWater named is cancelled through DeepWater, and an ended one not at all', async (fixture) => {
  const { run: named } = await insertBrief(fixture, personOrigin())
  await fixture.pool.query(
    `UPDATE product_integration_runs SET external_run_id = 'rs_localcancelnamed', status = 'drafting' WHERE id = $1`,
    [named.id],
  )
  assert.equal(await cancel(fixture, named.id), 'opened')
  assert.equal((await read(fixture, named.id)).status, 'drafting', 'nothing changes here')

  const { run: refused } = await insertBrief(fixture, personOrigin())
  await fixture.pool.query(
    `UPDATE product_integration_runs SET status = 'failed', failure_code = 'scope_limit' WHERE id = $1`,
    [refused.id],
  )
  assert.equal(await cancel(fixture, refused.id), 'not_cancellable')
  assert.equal(await cancel(fixture, randomUUID()), null)
})
