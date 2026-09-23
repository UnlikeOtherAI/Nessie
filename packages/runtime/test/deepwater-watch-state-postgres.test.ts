import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerScopeResult, LedgerScopeTurn } from '@nessie/schemas'

import { applyDeepWaterScopeResult } from '../src/deepwater-brief-projection.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import {
  claimDeepWaterTurnWake,
  claimDueDeepWaterWatchRuns,
  findUnconfirmedDeepWaterBriefs,
  reapUnconfirmedDeepWaterBrief,
  recordDeepWaterAgentWake,
  retryDeepWaterWatchSoon,
  settleStaleDeepWaterAction,
} from '../src/deepwater-watch-state.js'
import {
  agentOrigin,
  insertBrief,
  personOrigin,
  scopeBrief,
  seedBriefFixture,
  type BriefFixture,
} from './deepwater-brief-fixture.js'

/**
 * The watch's own state against PostgreSQL (Water plan amendments-fable F1,
 * amendments N4, N5): which runs a claim takes, the one-time reap, the stale
 * action rule and the per-turn wake claim.
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

const researchId = (): string => `rs_${randomUUID().replaceAll('-', '')}`

const turn = (overrides: Partial<LedgerScopeTurn> = {}): LedgerScopeTurn => ({
  id: randomUUID(),
  seq: 1,
  status: 'complete',
  authorKind: 'agent',
  errorCode: null,
  retryable: false,
  ...overrides,
})

const result = (id: string, overrides: Partial<LedgerScopeResult> = {}): LedgerScopeResult => ({
  id,
  status: 'drafting',
  errorCode: null,
  title: null,
  turn: turn(),
  brief: null,
  ...overrides,
})

const apply = (fixture: BriefFixture, runId: string, scope: LedgerScopeResult) =>
  fixture.prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
    organizationId: fixture.ids.organization,
    runId,
    result: scope,
  }))

const makeDue = (fixture: BriefFixture, runId: string) => fixture.pool.query(
  `UPDATE product_integration_runs SET reconcile_after = now() - interval '1 second' WHERE id = $1`,
  [runId],
)

const setPendingAction = (fixture: BriefFixture, runId: string, action: Record<string, unknown>) =>
  fixture.pool.query(
    `UPDATE product_integration_runs SET scope_json = jsonb_set(scope_json, '{pendingAction}', $2::jsonb) WHERE id = $1`,
    [runId, JSON.stringify({ since: new Date().toISOString(), turnId: null, error: null, ...action })],
  )

const read = (fixture: BriefFixture, runId: string) =>
  readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId })

withFixture('a claim takes due open runs and lost agent starts once, with one watch job each', async (fixture) => {
  const { run: drafting } = await insertBrief(fixture, personOrigin())
  await apply(fixture, drafting.id, result(researchId()))
  const { run: lostAgentStart } = await insertBrief(fixture, agentOrigin(fixture))
  const { run: unattachedPerson } = await insertBrief(fixture, personOrigin())
  const { run: blocked } = await insertBrief(fixture, personOrigin())
  await apply(fixture, blocked.id, result(researchId()))
  await fixture.pool.query(
    `UPDATE product_integration_runs SET delivery_blocked_reason = 'requester_identity_changed' WHERE id = $1`,
    [blocked.id],
  )
  const { run: staleAgentStart } = await insertBrief(fixture, agentOrigin(fixture))
  await fixture.pool.query(
    `UPDATE product_integration_runs SET created_at = now() - interval '25 hours' WHERE id = $1`,
    [staleAgentStart.id],
  )
  for (const run of [drafting, lostAgentStart, unattachedPerson, blocked, staleAgentStart]) await makeDue(fixture, run.id)

  const mine = (claims: Array<{ runId: string; reconcileSeq: number }>) =>
    claims.filter((claim) => [drafting, lostAgentStart, unattachedPerson, blocked, staleAgentStart]
      .some((run) => run.id === claim.runId))
  const first = mine(await fixture.prisma.$transaction((tx) => claimDueDeepWaterWatchRuns(tx, { limit: 50 })))
  assert.deepEqual(
    first.map((claim) => claim.runId).sort(),
    [drafting.id, lostAgentStart.id].sort(),
  )
  assert.ok(first.every((claim) => claim.reconcileSeq === 1))
  const jobs = await fixture.pool.query(
    `SELECT idempotency_key, max_attempts FROM queue_jobs WHERE topic = 'deep_water.run.watch' AND payload->>'organizationId' = $1`,
    [fixture.ids.organization],
  )
  assert.deepEqual(
    jobs.rows.map((row) => row.idempotency_key).sort(),
    [`deep-water-watch:${drafting.id}:1`, `deep-water-watch:${lostAgentStart.id}:1`].sort(),
  )
  assert.ok(jobs.rows.every((row) => row.max_attempts === 1))
  const claimed = await read(fixture, drafting.id)
  assert.ok(claimed && claimed.reconcileAfter.getTime() > Date.now() + 9 * 60_000, 'the claim backs off')

  assert.deepEqual(mine(await fixture.prisma.$transaction((tx) => claimDueDeepWaterWatchRuns(tx, { limit: 50 }))), [])
})

withFixture('a brief DeepWater never confirmed is reaped once, after a day, and stays attachable', async (fixture) => {
  const { run: young } = await insertBrief(fixture, personOrigin())
  const { run: old } = await insertBrief(fixture, personOrigin())
  await fixture.pool.query(
    `UPDATE product_integration_runs SET created_at = now() - interval '25 hours' WHERE id = $1`,
    [old.id],
  )
  const reap = (runId: string) => fixture.prisma.$transaction((tx) => reapUnconfirmedDeepWaterBrief(tx, {
    organizationId: fixture.ids.organization,
    runId,
  }))
  const due = await findUnconfirmedDeepWaterBriefs(fixture.prisma, { limit: 500 })
  assert.ok(due.some((target) => target.runId === old.id))
  assert.ok(!due.some((target) => target.runId === young.id))

  assert.equal(await reap(young.id), null)
  const reaped = await reap(old.id)
  assert.equal(reaped?.status, 'failed')
  assert.equal(reaped?.failureCode, 'start_unconfirmed')
  assert.equal(reaped?.scopeState?.pendingAction?.error?.code, 'unavailable')
  assert.equal(await reap(old.id), null, 'reaped once')
  assert.equal(reaped?.deliveredAt, null)

  const revived = await apply(fixture, old.id, result(researchId(), { turn: turn({ authorKind: 'person' }) }))
  assert.equal(revived.applied && revived.run.status, 'drafting')
})

withFixture('an action whose job is gone ends by what Ledger shows', async (fixture) => {
  const { run } = await insertBrief(fixture, personOrigin())
  const rs = researchId()
  const open = turn({ status: 'pending', authorKind: 'person' })
  await apply(fixture, run.id, result(rs, { turn: open }))
  const settle = (actionId: string) => fixture.prisma.$transaction((tx) => settleStaleDeepWaterAction(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    actionId,
  }))

  const reply = randomUUID()
  await setPendingAction(fixture, run.id, { kind: 'reply', actionId: reply, turnId: open.id })
  assert.equal(await settle(randomUUID()), 'none')
  assert.equal(await settle(reply), 'kept', 'the planner turn it opened is still answering')

  const lostReply = randomUUID()
  await setPendingAction(fixture, run.id, { kind: 'reply', actionId: lostReply })
  assert.equal(await settle(lostReply), 'unavailable')
  assert.equal((await read(fixture, run.id))?.scopeState?.pendingAction?.error?.code, 'unavailable')

  // A launch whose job died while Ledger still shows it starting (a bare
  // running, no proof of launch yet) ended with its job: the person may act again.
  const cutOff = randomUUID()
  await setPendingAction(fixture, run.id, { kind: 'launch', actionId: cutOff })
  await apply(fixture, run.id, result(rs, { status: 'running', turn: turn({ id: open.id, status: 'complete' }) }))
  assert.equal((await read(fixture, run.id))?.status, 'drafting')
  assert.equal(await settle(cutOff), 'unavailable')

  const launch = randomUUID()
  await setPendingAction(fixture, run.id, { kind: 'launch', actionId: launch })
  await apply(fixture, run.id, result(rs, {
    status: 'running',
    brief: scopeBrief('launched'),
    turn: turn({ id: open.id, status: 'complete' }),
  }))
  assert.equal(await settle(launch), 'finished')
  assert.equal((await read(fixture, run.id))?.scopeState?.pendingAction, null)

  // needs_setup is a launched research too.
  const { run: setup } = await insertBrief(fixture, personOrigin())
  const rsSetup = researchId()
  const setupTurn = turn({ authorKind: 'person' })
  await apply(fixture, setup.id, result(rsSetup, { turn: setupTurn }))
  const setupLaunch = randomUUID()
  await setPendingAction(fixture, setup.id, { kind: 'launch', actionId: setupLaunch })
  await apply(fixture, setup.id, result(rsSetup, { status: 'needs_setup', turn: setupTurn }))
  assert.equal(await fixture.prisma.$transaction((tx) => settleStaleDeepWaterAction(tx, {
    organizationId: fixture.ids.organization,
    runId: setup.id,
    actionId: setupLaunch,
  })), 'finished')
})

withFixture('a settled turn wakes its agent author once, in order; a person\'s turn only advances', async (fixture) => {
  const { run } = await insertBrief(fixture, agentOrigin(fixture))
  const rs = researchId()
  const claim = () => fixture.prisma.$transaction((tx) => claimDeepWaterTurnWake(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
  }))

  const opening = turn({ seq: 1, status: 'pending' })
  await apply(fixture, run.id, result(rs, { turn: opening }))
  assert.equal((await claim())?.decision.kind, 'none', 'an open turn wakes nobody')

  await apply(fixture, run.id, result(rs, { turn: { ...opening, status: 'complete' } }))
  const woke = await claim()
  assert.equal(woke?.decision.kind, 'wake')
  assert.equal(woke?.decision.kind === 'wake' && woke.decision.agentId, fixture.ids.agent)
  assert.equal(woke?.decision.kind === 'wake' && woke.decision.turn.id, opening.id)
  await fixture.prisma.$transaction((tx) => recordDeepWaterAgentWake(tx, { organizationId: fixture.ids.organization, runId: run.id }))
  assert.equal((await claim())?.decision.kind, 'none', 'a turn wakes once')

  const personTurn = turn({ seq: 2, authorKind: 'person' })
  await apply(fixture, run.id, result(rs, { turn: personTurn }))
  assert.equal((await claim())?.decision.kind, 'none')
  assert.equal((await read(fixture, run.id))?.lastHandledTurnSeq, 2)

  await fixture.pool.query(`UPDATE product_integration_runs SET agent_wake_count = 8 WHERE id = $1`, [run.id])
  await apply(fixture, run.id, result(rs, { turn: turn({ seq: 3 }) }))
  assert.equal((await claim())?.decision.kind, 'cap_notice')
  await apply(fixture, run.id, result(rs, { turn: turn({ seq: 4 }) }))
  assert.equal((await claim())?.decision.kind, 'none', 'the cap notice is posted once')
  assert.ok((await read(fixture, run.id))?.wakeCapNoticeAt)
})

withFixture('an attach that names a finished research leaves the run where the next claim reads it again', async (fixture) => {
  // A queued brief whose first acknowledgement already reports the research finished.
  const { run: queued } = await insertBrief(fixture, personOrigin())
  const rsQueued = researchId()
  const finished = await apply(fixture, queued.id, result(rsQueued, { status: 'complete', turn: turn({ authorKind: 'person' }) }))
  assert.equal(finished.applied && finished.attached, true)
  // Ledger finishes only launched research, so the launch is seen before its result.
  assert.equal(finished.applied && finished.run.status, 'running', 'a finished research was launched')
  assert.ok(finished.applied && finished.run.launchedAt)
  assert.equal(finished.applied && finished.run.externalRunId, rsQueued)
  assert.deepEqual(finished.applied && finished.ledgerTerminal, { status: 'complete', errorCode: null })

  // A reaped brief revived by a read that reports the research failed.
  const { run: reaped } = await insertBrief(fixture, agentOrigin(fixture))
  await fixture.pool.query(
    `UPDATE product_integration_runs SET status = 'failed', failure_code = 'start_unconfirmed', completed_at = now() WHERE id = $1`,
    [reaped.id],
  )
  const rsReaped = researchId()
  const revived = await apply(fixture, reaped.id, result(rsReaped, { status: 'failed', errorCode: 'upstream_failed' }))
  assert.equal(revived.applied && revived.run.status, 'drafting', 'the attach makes it drafting (N1); a bare failed is no launch')
  assert.equal(revived.applied && revived.run.failureCode, null)
  assert.deepEqual(revived.applied && revived.ledgerTerminal, { status: 'failed', errorCode: 'upstream_failed' })

  // Neither delivery finished (it threw, or asked to be tried again): the next
  // claim takes both, so the watch reads them and delivers.
  for (const run of [queued, reaped]) await makeDue(fixture, run.id)
  const claimed = (await fixture.prisma.$transaction((tx) => claimDueDeepWaterWatchRuns(tx, { limit: 50 })))
    .map((claim) => claim.runId)
  assert.ok(claimed.includes(queued.id), 'the attached run is claimed again')
  assert.ok(claimed.includes(reaped.id), 'the revived run is claimed again')
  assert.equal((await read(fixture, queued.id))?.deliveredAt, null)
})

withFixture('a read that failed for a passing reason is tried again soon only while the run moves fast', async (fixture) => {
  const claimOf = async (runId: string) => {
    await makeDue(fixture, runId)
    const claims = await fixture.prisma.$transaction((tx) => claimDueDeepWaterWatchRuns(tx, { limit: 50 }))
    const claim = claims.find((entry) => entry.runId === runId)
    assert.ok(claim, 'the run was claimed')
    return claim
  }
  const retry = (runId: string, reconcileSeq: number) => fixture.prisma.$transaction((tx) =>
    retryDeepWaterWatchSoon(tx, { organizationId: fixture.ids.organization, runId, reconcileSeq }))
  const scheduledIn = async (runId: string) =>
    ((await read(fixture, runId))?.reconcileAfter.getTime() ?? 0) - Date.now()

  // A research that is running: the claim backed it off; the failed read brings it back within 30 s.
  const { run: research } = await insertBrief(fixture, personOrigin())
  await apply(fixture, research.id, result(researchId(), { status: 'running', brief: scopeBrief('launched') }))
  const researchClaim = await claimOf(research.id)
  assert.ok(await scheduledIn(research.id) > 9 * 60_000)
  assert.equal(await retry(research.id, researchClaim.reconcileSeq - 1), false, 'an older claim owns nothing')
  assert.equal(await retry(research.id, researchClaim.reconcileSeq), true)
  const soon = await scheduledIn(research.id)
  assert.ok(soon > 20_000 && soon <= 30_000, `read again within 30 s (${soon} ms)`)
  assert.equal(await retry(research.id, researchClaim.reconcileSeq), false, 'never later, never twice')

  // A quiet brief — nothing in flight — keeps the claim's backoff.
  const { run: quiet } = await insertBrief(fixture, personOrigin())
  await apply(fixture, quiet.id, result(researchId()))
  await fixture.pool.query(
    `UPDATE product_integration_runs SET scope_json = jsonb_set(scope_json, '{pendingAction}', 'null'::jsonb) WHERE id = $1`,
    [quiet.id],
  )
  const quietClaim = await claimOf(quiet.id)
  assert.equal(await retry(quiet.id, quietClaim.reconcileSeq), false)
  assert.ok(await scheduledIn(quiet.id) > 9 * 60_000)

  // A planner turn in flight is fast too.
  const { run: talking } = await insertBrief(fixture, personOrigin())
  await apply(fixture, talking.id, result(researchId(), { turn: turn({ status: 'pending', authorKind: 'person' }) }))
  const talkingClaim = await claimOf(talking.id)
  assert.equal(await retry(talking.id, talkingClaim.reconcileSeq), true)
})
