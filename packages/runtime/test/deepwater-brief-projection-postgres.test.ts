import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerScopeResult, LedgerScopeTurn } from '@nessie/schemas'

import {
  DeepWaterResearchIdMismatchError,
  DeepWaterResearchIdTakenError,
  applyDeepWaterLaunchTicket,
  applyDeepWaterScopeResult,
  applyDeepWaterStatusRead,
} from '../src/deepwater-brief-projection.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import {
  agentOrigin,
  insertBrief,
  personOrigin,
  seedBriefFixture,
  type BriefFixture,
} from './deepwater-brief-fixture.js'

/**
 * The brief projection against PostgreSQL: the migration's CHECKs and partial
 * unique indexes, the row lock every application serialises on, and the
 * N1/N2 ordering guarantees — an ack, a watch read and a revival converge on
 * one row whatever order they arrive in.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const T1 = randomUUID()
const T2 = randomUUID()

const turn = (overrides: Partial<LedgerScopeTurn> = {}): LedgerScopeTurn => ({
  id: T1,
  seq: 1,
  status: 'pending',
  authorKind: 'person',
  errorCode: null,
  retryable: false,
  ...overrides,
})

const scopeResult = (researchId: string, overrides: Partial<LedgerScopeResult> = {}): LedgerScopeResult => ({
  id: researchId,
  status: 'drafting',
  errorCode: null,
  title: null,
  turn: turn(),
  brief: null,
  ...overrides,
})

const researchId = (): string => `rs_${randomUUID().replaceAll('-', '')}`

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

const apply = (fixture: BriefFixture, runId: string, result: LedgerScopeResult, ackActionId?: string) =>
  fixture.prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
    organizationId: fixture.ids.organization,
    runId,
    result,
    ackActionId: ackActionId ?? null,
  }))

withFixture('both insert paths are idempotent on their origin key and write the brief binding', async (fixture) => {
  const origin = personOrigin()
  const person = await insertBrief(fixture, origin)
  assert.equal(person.created, true)
  assert.equal(person.run.status, 'queued')
  assert.equal(person.run.originKind, 'person')
  assert.deepEqual(person.run.uoaIdentity, fixture.identity)
  assert.equal(person.run.scopeState?.pendingAction?.kind, 'scope_start')
  assert.equal(person.run.input?.topic, 'Heat pumps in older houses')
  const replay = await insertBrief(fixture, origin)
  assert.deepEqual({ id: replay.run.id, created: replay.created }, { id: person.run.id, created: false })

  const agentCall = agentOrigin(fixture)
  const agent = await insertBrief(fixture, agentCall)
  assert.equal(agent.run.originKind, 'agent')
  assert.equal(agent.run.principalUserId, fixture.ids.requester)
  assert.equal(agent.run.scopeState?.pendingAction, null)
  assert.equal((await insertBrief(fixture, agentCall)).run.id, agent.run.id)
  assert.notEqual((await insertBrief(fixture, agentOrigin(fixture))).run.id, agent.run.id)
})

withFixture('the binding CHECKs refuse half a brief and an unkeyed agent row', async (fixture) => {
  const insert = (columns: string, values: string) => fixture.pool.query(
    `INSERT INTO product_integration_runs (organization_id, team_id, product_slug, status, updated_at${columns})
     VALUES ($1, $2, 'deep-water', 'queued', now()${values})`,
    [fixture.ids.organization, fixture.ids.team],
  )
  await assert.rejects(insert(', uoa_identity', `, '{"subject":"s"}'::jsonb`), /brief_binding_shape/)
  await assert.rejects(insert(', scope_json', `, '{}'::jsonb`), /brief_binding_shape/)
  await assert.rejects(insert(', origin_kind', `, 'agent'`), /agent_origin_tool_call_check/)
  // A legacy launcher row writes neither and stays valid.
  await insert('', '')
})

withFixture('an ack attaches the research, records the opening author and turn, and the settled read clears it', async (fixture) => {
  const origin = personOrigin()
  const { run } = await insertBrief(fixture, origin)
  const rs = researchId()
  const acked = await apply(fixture, run.id, scopeResult(rs, { title: 'Heat pumps' }), (origin as { actionId: string }).actionId)
  assert.equal(acked.applied, true)
  if (!acked.applied) return
  assert.equal(acked.attached, true)
  assert.equal(acked.run.status, 'drafting')
  assert.equal(acked.run.externalRunId, rs)
  assert.equal(acked.run.title, 'Heat pumps')
  assert.deepEqual(acked.run.scopeState?.turnAuthors[T1], { kind: 'person', userId: fixture.ids.requester })
  assert.equal(acked.run.scopeState?.pendingAction?.turnId, T1)
  // An open planner turn is watched every few seconds.
  assert.ok(acked.run.reconcileAfter.getTime() - Date.now() < 30_000)

  const settled = await apply(fixture, run.id, scopeResult(rs, { turn: turn({ status: 'complete' }) }))
  assert.equal(settled.applied && settled.pendingActionCleared, true)
  assert.equal(settled.applied && settled.newlySettledTurn?.id, T1)
  assert.equal(settled.applied && settled.run.scopeState?.pendingAction, null)
})

withFixture('a watch read that arrives before the ack attaches, and the late ack changes nothing', async (fixture) => {
  const origin = personOrigin()
  const { run } = await insertBrief(fixture, origin)
  const rs = researchId()
  const read = await apply(fixture, run.id, scopeResult(rs, { turn: turn({ status: 'failed', retryable: true }) }))
  assert.equal(read.applied && read.attached, true)
  assert.equal(read.applied && read.run.scopeState?.pendingAction, null)

  const lateAck = await apply(fixture, run.id, scopeResult(rs), (origin as { actionId: string }).actionId)
  assert.equal(lateAck.applied, true)
  const stored = await readDeepWaterBriefRun(fixture.prisma, {
    organizationId: fixture.ids.organization, runId: run.id,
  })
  assert.equal(stored?.scopeState?.turn?.status, 'failed')
  assert.equal(stored?.scopeState?.pendingAction, null)
})

withFixture('a reaped brief is revived by a later read, and a running legacy-shaped row is never attached', async (fixture) => {
  const { run } = await insertBrief(fixture, agentOrigin(fixture))
  await fixture.pool.query(
    `UPDATE product_integration_runs SET status = 'failed', failure_code = 'start_unconfirmed', completed_at = now() WHERE id = $1`,
    [run.id],
  )
  const revived = await apply(fixture, run.id, scopeResult(researchId(), { turn: turn({ authorKind: 'agent' }) }))
  assert.equal(revived.applied && revived.run.status, 'drafting')
  assert.equal(revived.applied && revived.run.failureCode, null)
  assert.deepEqual(revived.applied && revived.run.scopeState?.turnAuthors[T1], { kind: 'agent', agentId: fixture.ids.agent })

  const { run: other } = await insertBrief(fixture, agentOrigin(fixture))
  await fixture.pool.query(`UPDATE product_integration_runs SET status = 'running' WHERE id = $1`, [other.id])
  assert.deepEqual(await apply(fixture, other.id, scopeResult(researchId())), { applied: false, reason: 'not_attachable' })
})

withFixture('a research id binds to exactly one run', async (fixture) => {
  const rs = researchId()
  const { run: first } = await insertBrief(fixture)
  const { run: second } = await insertBrief(fixture)
  await apply(fixture, first.id, scopeResult(rs))
  await assert.rejects(apply(fixture, second.id, scopeResult(rs)), DeepWaterResearchIdTakenError)
  await assert.rejects(apply(fixture, first.id, scopeResult(researchId())), DeepWaterResearchIdMismatchError)
})

withFixture('concurrent reads of one turn converge on the settled state', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const rs = researchId()
  await apply(fixture, run.id, scopeResult(rs, { turn: turn({ status: 'complete' }) }))
  const reads = [
    scopeResult(rs, { turn: turn({ id: T2, seq: 2, status: 'pending' }) }),
    scopeResult(rs, { turn: turn({ id: T2, seq: 2, status: 'failed', errorCode: 'planner_failed', retryable: true }) }),
    scopeResult(rs, { turn: turn({ status: 'complete' }) }),
  ]
  const outcomes = await Promise.all(reads.map((read) => apply(fixture, run.id, read)))
  const settledNow = outcomes.filter((outcome) => outcome.applied && outcome.newlySettledTurn?.id === T2)
  assert.equal(settledNow.length, 1, 'exactly one application settles turn 2')
  const stored = await readDeepWaterBriefRun(fixture.prisma, {
    organizationId: fixture.ids.organization, runId: run.id,
  })
  assert.deepEqual(
    { id: stored?.scopeState?.turn?.id, status: stored?.scopeState?.turn?.status },
    { id: T2, status: 'failed' },
  )
})

withFixture('a launch ticket starts the research and never settles a newer action', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const rs = researchId()
  await apply(fixture, run.id, scopeResult(rs, { turn: turn({ status: 'complete' }) }))
  const setAction = (kind: 'launch' | 'cancel', actionId: string) => fixture.pool.query(
    `UPDATE product_integration_runs
     SET scope_json = jsonb_set(scope_json, '{pendingAction}', $2::jsonb) WHERE id = $1`,
    [run.id, JSON.stringify({ kind, actionId, since: new Date().toISOString(), turnId: null, error: null })],
  )
  const ticket = (ackActionId: string) => fixture.prisma.$transaction((tx) => applyDeepWaterLaunchTicket(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    ticket: { id: rs, status: 'running' },
    ackActionId,
  }))

  const launchAction = randomUUID()
  await setAction('launch', launchAction)
  const launched = await ticket(launchAction)
  assert.equal(launched.applied && launched.run.status, 'running')
  assert.equal(launched.applied && launched.launched, true)
  assert.ok(launched.applied && launched.run.launchedAt)
  assert.equal(launched.applied && launched.run.scopeState?.pendingAction, null)

  // The person pressed Cancel; a replayed launch ack must leave that in flight.
  const cancelAction = randomUUID()
  await setAction('cancel', cancelAction)
  const replayed = await ticket(launchAction)
  assert.equal(replayed.applied && replayed.launched, false)
  assert.equal(replayed.applied && replayed.run.scopeState?.pendingAction?.actionId, cancelAction)
})

withFixture('status reads write cancelled directly and hand a finished research to delivery', async (fixture) => {
  const read = async (runId: string, rs: string, status: 'cancelled' | 'complete' | 'failed') =>
    fixture.prisma.$transaction((tx) => applyDeepWaterStatusRead(tx, {
      organizationId: fixture.ids.organization,
      runId,
      status: {
        id: rs, status, phase: null, sourcesFound: null, etaMinutes: null,
        title: 'Heat pumps', errorCode: status === 'failed' ? 'upstream_failed' : null, brief: null, publicUrl: null,
      },
    }))

  const { run: cancelled } = await insertBrief(fixture)
  const rsCancelled = researchId()
  await apply(fixture, cancelled.id, scopeResult(rsCancelled))
  const cancelledRead = await read(cancelled.id, rsCancelled, 'cancelled')
  assert.equal(cancelledRead.applied && cancelledRead.run.status, 'cancelled')
  assert.ok(cancelledRead.applied && cancelledRead.run.completedAt)
  assert.deepEqual(await read(cancelled.id, rsCancelled, 'complete'), { applied: false, reason: 'terminal' })

  const { run: finished } = await insertBrief(fixture)
  const rsFinished = researchId()
  await apply(fixture, finished.id, scopeResult(rsFinished))
  const failedRead = await read(finished.id, rsFinished, 'failed')
  assert.equal(failedRead.applied && failedRead.run.status, 'drafting')
  assert.deepEqual(failedRead.applied && failedRead.ledgerTerminal, { status: 'failed', errorCode: 'upstream_failed' })
  assert.equal(failedRead.applied && failedRead.run.title, 'Heat pumps')
})
