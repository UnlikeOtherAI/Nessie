import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import { revertDeepWaterLaunch } from '@nessie/runtime'
import {
  DEEP_WATER_BRIEF_ACTION_TOPIC,
  DeepWaterNoticeMessageMetadataSchema,
  deepWaterBriefActionJobKey,
} from '@nessie/schemas'

import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * A person's launch as the watch sees it (Water plan amendments N1, L3). Ledger
 * shows a launch whose call is still out (`starting`) as `running`, and puts it
 * back to `drafting` when Water refuses it, so a watch read during a launch is
 * no proof the research was launched: the brief stays its requester's, with no
 * card in the room, until Water's own brief says `launched`.
 */

const withFixture = (name: string, body: (fixture: WatchFixture) => Promise<void>): void => {
  runDatabaseTest(name, async (t) => {
    const probe = new PrismaClient()
    await assertGlobalQueuesQuiet(probe)
    await probe.$disconnect()
    const fixture = await seedWatchFixture()
    t.after(() => fixture.cleanup())
    await body(fixture)
  })
}

const watch = async (fixture: WatchFixture, runId: string) => watchDeepWaterRun(fixture.deps, await fixture.read(runId))

/** A drafted brief whose person pressed Start: the launch job is still running. */
const launching = async (fixture: WatchFixture) => {
  const run = await fixture.insert('person')
  const rs = researchId()
  const turnId = randomUUID()
  await fixture.attach(run.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: turnId, seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  const actionId = randomUUID()
  await fixture.prisma.$executeRawUnsafe(
    `UPDATE product_integration_runs SET scope_json = jsonb_set(scope_json, '{pendingAction}', $2::jsonb) WHERE id = $1::uuid`,
    run.id,
    JSON.stringify({ kind: 'launch', actionId, since: new Date().toISOString(), turnId: null, error: null }),
  )
  await enqueueQueueJob(fixture.prisma, {
    idempotencyKey: deepWaterBriefActionJobKey(run.id, actionId),
    payload: { organizationId: fixture.ids.organization, runId: run.id, actionId },
    topic: DEEP_WATER_BRIEF_ACTION_TOPIC,
  })
  return { run, rs, turnId, actionId }
}

const roomMessages = (fixture: WatchFixture) =>
  fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread } })

withFixture('a watch read during a launch Water then refuses leaves no card in the room', async (fixture) => {
  const { run, rs, turnId, actionId } = await launching(fixture)

  // Ledger has moved the brief to `starting` (shown as running); Water has not launched it.
  fixture.ledger.answer('research_scope_get', {
    ...wireScope({ id: rs, revision: 2, turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'person' } }),
    status: 'running',
  })
  await watch(fixture, run.id)
  const seen = await fixture.read(run.id)
  assert.equal(seen.status, 'drafting', 'a launch in flight is not a launch yet')
  assert.equal(seen.launchedAt, null)
  assert.equal(seen.cardMessageId, null)
  assert.equal(seen.scopeState?.pendingAction?.actionId, actionId, 'the launch job still owns its action')
  assert.deepEqual(await roomMessages(fixture), [], 'the room is not shown the brief')

  // Water refuses the launch; Ledger reverts it, and the launch job ends its action.
  const reverted = await fixture.prisma.$transaction((tx) => revertDeepWaterLaunch(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    actionId,
    errorCode: 'revision_conflict',
  }))
  assert.equal(reverted, true)
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'drafting')
  assert.equal(after.launchedAt, null)
  assert.equal(after.cardMessageId, null)
  assert.deepEqual(await roomMessages(fixture), [], 'nothing in the room names the private brief')

  // Refused later for good, it is told to its requester alone.
  fixture.ledger.answer('research_scope_get', {
    ...wireScope({ id: rs, revision: 2, turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'person' } }),
    status: 'failed',
    error_code: 'scope_rejected',
  })
  await watch(fixture, run.id)
  assert.deepEqual(await roomMessages(fixture), [])
  const told = (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.assistantThread } }))
    .filter((message) => DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata).success)
  assert.equal(told.length, 1)
})

withFixture('a launch Water accepted is seen from its brief, and posts the card once', async (fixture) => {
  const { run, rs, turnId } = await launching(fixture)

  // Water launched it; Ledger may still say `starting` (shown as running).
  fixture.ledger.answer('research_scope_get', {
    ...wireScope({
      id: rs,
      revision: 2,
      briefState: 'launched',
      turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'person' },
    }),
    status: 'running',
    title: 'Heat pumps',
  })
  await watch(fixture, run.id)
  const launched = await fixture.read(run.id)
  assert.equal(launched.status, 'running')
  assert.ok(launched.launchedAt)
  assert.ok(launched.cardMessageId, 'the room is shown the research')
  const [card, ...others] = await roomMessages(fixture)
  assert.equal(others.length, 0)
  assert.equal(card?.id, launched.cardMessageId)
  assert.equal(card?.role, 'user')
  assert.equal(card?.userId, fixture.ids.requester)
})
