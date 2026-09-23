import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LedgerResearchStatusDtoSchema,
  type DeepWaterResearchEvent,
  type DeepWaterResearchProgress,
  type LedgerScopeResult,
} from '@nessie/schemas'

import { applyDeepWaterScopeResult, applyDeepWaterStatusRead } from '../src/deepwater-brief-projection.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import {
  applyDeepWaterProgress,
  enqueueDeepWaterResearchEvent,
  resolveDeepWaterEventRun,
} from '../src/deepwater-research-events.js'
import { claimDeepWaterEventRead } from '../src/deepwater-watch-state.js'
import { agentOrigin, insertBrief, scopeBrief, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * DeepWater's research events against PostgreSQL (Water plan
 * amendments-streaming S2): which run an event is about, the progress it may
 * store and in which order, and the watch read a turn or an outcome claims.
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

const scope = (id: string, overrides: Partial<LedgerScopeResult> = {}): LedgerScopeResult => ({
  id,
  status: 'drafting',
  errorCode: null,
  title: null,
  turn: null,
  brief: null,
  ...overrides,
})

const read = async (fixture: BriefFixture, runId: string) => {
  const run = await readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId })
  assert.ok(run, `run ${runId} is gone`)
  return run
}

/** An opened brief, attached to its research and launched: a running research. */
const runningResearch = async (fixture: BriefFixture) => {
  const { run } = await insertBrief(fixture)
  const rs = researchId()
  await fixture.prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    result: scope(rs, { status: 'running', brief: scopeBrief('launched') }),
  }))
  assert.equal((await read(fixture, run.id)).status, 'running')
  return { runId: run.id, rs }
}

const event = (
  fixture: BriefFixture,
  research: string,
  nessie: Partial<DeepWaterResearchEvent['nessie']> = {},
): Pick<DeepWaterResearchEvent, 'research' | 'nessie'> => ({
  research: {
    ledger_research_id: research,
    status: 'running',
    title: null,
    report_kind: null,
    public_url: null,
    error_code: null,
  },
  nessie: {
    organization_id: fixture.ids.organization,
    team_id: fixture.ids.team,
    user_id: fixture.ids.requester,
    run_id: randomUUID(),
    agent_id: null,
    tool_call_id: null,
    thread_id: null,
    ...nessie,
  },
})

const snapshot = (at: string, overrides: Partial<DeepWaterResearchProgress> = {}): DeepWaterResearchProgress => ({
  phase: 'gathering',
  note: 'Finding and reading sources',
  percent: 40,
  sourcesFound: 23,
  at,
  ...overrides,
})

const progress = (fixture: BriefFixture, runId: string, researchIdValue: string, value: DeepWaterResearchProgress) =>
  fixture.prisma.$transaction((tx) => applyDeepWaterProgress(tx, {
    organizationId: fixture.ids.organization,
    runId,
    researchId: researchIdValue,
    progress: value,
  }))

withFixture('an event is about the run bound to its research, only inside the organisation it names', async (fixture) => {
  const { runId, rs } = await runningResearch(fixture)
  assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, rs)), {
    kind: 'run', organizationId: fixture.ids.organization, runId,
  })
  // The same research named from another organisation matches nothing.
  assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, rs, { organization_id: randomUUID() })), {
    kind: 'refused', reason: 'run_not_found',
  })
  assert.deepEqual(
    await resolveDeepWaterEventRun(fixture.prisma, event(fixture, rs, { organization_id: 'not-a-uuid' })),
    { kind: 'refused', reason: 'run_not_found' },
  )
  assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, researchId())), {
    kind: 'refused', reason: 'run_not_found',
  })
})

withFixture('an agent\'s brief with no research id yet is found by the call that opened it', async (fixture) => {
  const { run } = await insertBrief(fixture, agentOrigin(fixture, 'call_scope_start_ev'))
  const opener = { run_id: fixture.ids.originRun, tool_call_id: 'call_scope_start_ev', agent_id: fixture.ids.agent }
  assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, researchId(), opener)), {
    kind: 'run', organizationId: fixture.ids.organization, runId: run.id,
  })
  // Another call, another agent, or another organisation: not this brief.
  for (const other of [
    { ...opener, tool_call_id: 'call_other' },
    { ...opener, agent_id: randomUUID() },
    { ...opener, organization_id: randomUUID() },
    { ...opener, agent_id: null },
  ]) {
    assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, researchId(), other)), {
      kind: 'refused', reason: 'run_not_found',
    }, JSON.stringify(other))
  }
  // A person's brief not yet attached is its opening job's to attach, never an event's.
  const person = await insertBrief(fixture)
  assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, researchId(), {
    run_id: person.run.id, tool_call_id: `brief:${person.run.id}:x`, agent_id: randomUUID(),
  })), { kind: 'refused', reason: 'run_not_found' })
})

withFixture('a launcher run is named but not accepted: its handoff owns it', async (fixture) => {
  const rs = researchId()
  await fixture.pool.query(
    `INSERT INTO product_integration_runs (id, organization_id, team_id, product_slug, status, external_run_id, updated_at)
     VALUES ($1, $2, $3, 'deep-water', 'running', $4, now())`,
    [randomUUID(), fixture.ids.organization, fixture.ids.team, rs],
  )
  assert.deepEqual(await resolveDeepWaterEventRun(fixture.prisma, event(fixture, rs)), {
    kind: 'refused', reason: 'legacy_run',
  })
})

withFixture('an event is queued once, keyed by its id', async (fixture) => {
  const { runId } = await runningResearch(fixture)
  const payload = {
    organizationId: fixture.ids.organization,
    runId,
    event: {
      ver: 'deepwater.research-event.v1' as const,
      event_id: `evt_${randomUUID().replaceAll('-', '')}`,
      type: 'research.failed' as const,
      sent_at: new Date().toISOString(),
      occurred_at: new Date().toISOString(),
      ...event(fixture, researchId()),
      progress: null,
      turn: null,
    },
  }
  payload.event.research = { ...payload.event.research, status: 'failed', error_code: 'quality_gate_failed' }
  assert.equal(await enqueueDeepWaterResearchEvent(fixture.prisma, payload), true)
  assert.equal(await enqueueDeepWaterResearchEvent(fixture.prisma, payload), false, 'a resent event is the same job')
  const jobs = await fixture.pool.query(
    `SELECT topic, idempotency_key, max_attempts FROM queue_jobs WHERE payload->>'runId' = $1`,
    [runId],
  )
  assert.deepEqual(jobs.rows, [{
    topic: 'deep_water.research.event',
    idempotency_key: `deep-water-event:${payload.event.event_id}`,
    max_attempts: 1,
  }])
})

withFixture('progress is stored only when DeepWater observed it later, and marks the run changed', async (fixture) => {
  const { runId, rs } = await runningResearch(fixture)
  await fixture.pool.query(
    `UPDATE product_integration_runs SET ledger_observed_at = now() - interval '1 hour' WHERE id = $1`,
    [runId],
  )
  const first = snapshot('2026-09-23T10:15:00.000Z')
  const stored = await progress(fixture, runId, rs, first)
  assert.equal(stored.applied, true)
  let run = await read(fixture, runId)
  assert.deepEqual(run.scopeState?.progress, first)
  assert.ok(run.lastEventAt, 'the event is recorded')
  assert.ok(Date.now() - run.ledgerObservedAt.getTime() < 60_000, 'the run changed now')

  // An older snapshot arriving late never moves the card backwards; the same instant is not newer.
  const older = await progress(fixture, runId, rs, snapshot('2026-09-23T10:14:00.000Z', { phase: 'scoping' }))
  assert.deepEqual(older, { applied: false, reason: 'stale' })
  assert.deepEqual(await progress(fixture, runId, rs, snapshot(first.at, { percent: 90 })), {
    applied: false, reason: 'stale',
  })
  assert.deepEqual((await read(fixture, runId)).scopeState?.progress, first)

  const later = snapshot('2026-09-23T10:16:00.000Z', { phase: 'writing_report', note: 'Finished chapter 3 of 8',
    percent: 38, sourcesFound: 31 })
  assert.equal((await progress(fixture, runId, rs, later)).applied, true)
  run = await read(fixture, runId)
  assert.deepEqual(run.scopeState?.progress, later)
  // Progress is all it touches.
  assert.equal(run.status, 'running')
  assert.equal(run.deliveredAt, null)
})

withFixture('progress for another research, an unattached run or an ended one is not stored', async (fixture) => {
  const { runId, rs } = await runningResearch(fixture)
  assert.deepEqual(await progress(fixture, runId, researchId(), snapshot(new Date().toISOString())), {
    applied: false, reason: 'not_bound',
  })
  const { run: unattached } = await insertBrief(fixture)
  assert.deepEqual(await progress(fixture, unattached.id, rs, snapshot(new Date().toISOString())), {
    applied: false, reason: 'not_bound',
  })
  await fixture.pool.query(`UPDATE product_integration_runs SET status = 'completed' WHERE id = $1`, [runId])
  assert.deepEqual(await progress(fixture, runId, rs, snapshot(new Date().toISOString())), {
    applied: false, reason: 'closed',
  })
  assert.equal((await read(fixture, runId)).scopeState?.progress, null)
})

withFixture('a turn or an outcome claims a watch read now, only of a run the watch reads', async (fixture) => {
  const { runId, rs } = await runningResearch(fixture)
  const before = await read(fixture, runId)
  const claim = await fixture.prisma.$transaction((tx) => claimDeepWaterEventRead(tx, {
    organizationId: fixture.ids.organization,
    runId,
  }))
  assert.deepEqual(claim, {
    runId, organizationId: fixture.ids.organization, reconcileSeq: before.reconcileSeq + 1,
  })
  const claimed = await read(fixture, runId)
  assert.ok(claimed.lastEventAt, 'the event is recorded')
  assert.ok(claimed.reconcileAfter.getTime() > Date.now() + 9 * 60_000, 'backed off until the read sets its cadence')

  // The read that follows sets the backstop cadence: 60 s while events arrive.
  await fixture.prisma.$transaction((tx) => applyDeepWaterStatusRead(tx, {
    organizationId: fixture.ids.organization,
    runId,
    status: LedgerResearchStatusDtoSchema.parse({ id: rs, status: 'running', title: null, error_code: null,
      public_url: null }),
  }))
  const scheduled = (await read(fixture, runId)).reconcileAfter.getTime() - Date.now()
  assert.ok(scheduled > 50_000 && scheduled <= 61_000, `next read in ${scheduled} ms`)

  // A blocked run is its requester's to renew: the event is recorded, and nothing is read.
  await fixture.pool.query(
    `UPDATE product_integration_runs SET delivery_blocked_reason = 'requester_identity_changed' WHERE id = $1`,
    [runId],
  )
  assert.equal(await fixture.prisma.$transaction((tx) => claimDeepWaterEventRead(tx, {
    organizationId: fixture.ids.organization,
    runId,
  })), null)
  assert.equal((await read(fixture, runId)).reconcileSeq, claimed.reconcileSeq)

  // An agent's brief whose research id never came back is read (its scope start replayed).
  const { run: lost } = await insertBrief(fixture, agentOrigin(fixture))
  const replay = await fixture.prisma.$transaction((tx) => claimDeepWaterEventRead(tx, {
    organizationId: fixture.ids.organization,
    runId: lost.id,
  }))
  assert.equal(replay?.reconcileSeq, lost.reconcileSeq + 1)
})
