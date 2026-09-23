import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { beginDeepWaterDeliveryRetry } from '../src/deepwater-delivery-retry.js'
import { insertBrief, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * A person's Retry on a blocked DeepWater delivery (Water plan amendments N3,
 * amendments-fable F4): the block is lifted and the delivery enqueued once per
 * actionId; a changed sign-in is lifted only by that same person signing in
 * again; a delivery that is not blocked, or blocked for good, has nothing to
 * retry.
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

const blocked = async (fixture: BriefFixture, reason: string | null): Promise<string> => {
  const { run } = await insertBrief(fixture)
  await fixture.pool.query(
    `UPDATE product_integration_runs SET status = 'running', delivery_blocked_reason = $2 WHERE id = $1`,
    [run.id, reason],
  )
  return run.id
}

const retry = (fixture: BriefFixture, runId: string, actionId: string, identity = fixture.identity) =>
  fixture.prisma.$transaction((tx) => beginDeepWaterDeliveryRetry(tx, {
    organizationId: fixture.ids.organization,
    runId,
    actionId,
    identity,
  }))

const deliverJobs = async (fixture: BriefFixture, runId: string) =>
  (await fixture.pool.query(
    `SELECT payload FROM queue_jobs WHERE topic = 'deep_water.run.deliver' AND payload->>'runId' = $1`,
    [runId],
  )).rows

withFixture('Retry lifts a retryable block and enqueues the delivery once per action', async (fixture) => {
  const runId = await blocked(fixture, 'ledger_unavailable')
  const actionId = randomUUID()
  const started = await retry(fixture, runId, actionId)
  assert.equal(started.kind, 'started')
  assert.equal(started.kind === 'started' ? started.run.deliveryBlockedReason : 'unexpected', null)
  assert.equal((await retry(fixture, runId, actionId)).kind, 'replay')
  const jobs = await deliverJobs(fixture, runId)
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0]?.payload.identity, fixture.identity)
})

withFixture('a changed sign-in is lifted only by the same person signing in again', async (fixture) => {
  const runId = await blocked(fixture, 'requester_identity_changed')
  const someoneElse = { ...fixture.identity, subject: `${fixture.identity.subject}-other` }
  assert.equal((await retry(fixture, runId, randomUUID(), someoneElse)).kind, 'identity_mismatch')
  assert.equal((await deliverJobs(fixture, runId)).length, 0)

  const renewed = { ...fixture.identity, tokenVersion: fixture.identity.tokenVersion + 1 }
  const started = await retry(fixture, runId, randomUUID(), renewed)
  assert.equal(started.kind, 'started')
  if (started.kind !== 'started') return
  assert.equal(started.run.deliveryBlockedReason, null)
  assert.deepEqual(started.run.uoaIdentity, renewed)
})

withFixture('a delivery that is not blocked, or blocked for good, has nothing to retry', async (fixture) => {
  assert.equal((await retry(fixture, await blocked(fixture, null), randomUUID())).kind, 'not_blocked')
  const expired = await blocked(fixture, 'report_expired')
  assert.equal((await retry(fixture, expired, randomUUID())).kind, 'not_blocked')
  assert.equal((await deliverJobs(fixture, expired)).length, 0)
})
