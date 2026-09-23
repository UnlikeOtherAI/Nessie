import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { DeepWaterResearchLaunchRequestSchema } from '@nessie/schemas'

import { findDeepWaterBriefRunByResearchId } from '../src/deepwater-brief-run-record.js'
import {
  beginLegacyDeepWaterCancel,
  recordLegacyDeepWaterCancel,
} from '../src/deepwater-legacy-cancel.js'
import { createDeepWaterResearchRun } from '../src/integration-runs.js'
import { insertBrief, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * A launcher run (from before research briefs) can be cleared by a team owner
 * from the brief API (Water plan amendments N8.5, N9.6): cancelled here when
 * Ledger never received it, through Ledger when it has a research id, and not
 * at all while a start may still be in flight to Ledger.
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

const launcher = async (
  fixture: BriefFixture,
  row: { status: 'queued' | 'running' | 'needs_setup' | 'completed'; externalRunId?: string; startToolCallId?: string },
) => {
  const run = await createDeepWaterResearchRun(fixture.prisma, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
    connectorId: fixture.ids.connector,
    requestedByUserId: fixture.ids.requester,
    input: DeepWaterResearchLaunchRequestSchema.parse({ query: 'Launcher research on heat pumps' }),
  })
  await fixture.pool.query(
    `UPDATE product_integration_runs
     SET status = $2::"ProductIntegrationRunStatus", external_run_id = $3,
         result_json = COALESCE(result_json, '{}'::jsonb) || $4::jsonb
     WHERE id = $1`,
    [
      run.id,
      row.status,
      row.externalRunId ?? null,
      JSON.stringify(row.startToolCallId ? { startToolCallId: row.startToolCallId } : {}),
    ],
  )
  return run.id
}

const statusOf = async (fixture: BriefFixture, runId: string): Promise<string> =>
  (await fixture.prisma.productIntegrationRun.findUniqueOrThrow({ where: { id: runId } })).status

const begin = (fixture: BriefFixture, runId: string, actionId: string = randomUUID()) =>
  fixture.prisma.$transaction((tx) => beginLegacyDeepWaterCancel(tx, {
    organizationId: fixture.ids.organization,
    runId,
    actionId,
  }))

withFixture('a launcher run Ledger never received is cancelled here', async (fixture) => {
  const queued = await launcher(fixture, { status: 'queued' })
  const parked = await launcher(fixture, { status: 'needs_setup' })
  const actionId = randomUUID()
  assert.equal(await begin(fixture, queued, actionId), 'local')
  assert.equal(await begin(fixture, parked), 'local')
  assert.equal(await statusOf(fixture, queued), 'cancelled')
  assert.equal(await statusOf(fixture, parked), 'cancelled')
  // A retry whose first answer was lost is a replay, not a refusal…
  assert.equal(await begin(fixture, queued, actionId), 'replay')
  // …while a new request finds nothing left to cancel: cancelled is terminal.
  assert.equal(await begin(fixture, queued), 'not_cancellable')
})

withFixture('a start that may be in flight to Ledger is never cancelled locally', async (fixture) => {
  const starting = await launcher(fixture, { status: 'queued', startToolCallId: 'call_1' })
  const running = await launcher(fixture, { status: 'running', startToolCallId: 'call_2' })
  assert.equal(await begin(fixture, starting), 'not_cancellable')
  assert.equal(await begin(fixture, running), 'not_cancellable')
  assert.equal(await statusOf(fixture, starting), 'queued')
  assert.equal(await statusOf(fixture, running), 'running')
})

withFixture('a launcher research is cancelled through Ledger, then recorded once', async (fixture) => {
  const researchId = 'rs_legacycancel1'
  const running = await launcher(fixture, { status: 'running', externalRunId: researchId, startToolCallId: 'call_3' })
  assert.equal(await begin(fixture, running), 'ledger')
  assert.equal(await statusOf(fixture, running), 'running', 'nothing changes until Ledger agrees')
  // The route enqueues the worker's job under the action's key; a retry of it is a replay.
  const enqueuedId = randomUUID()
  await fixture.pool.query(
    `INSERT INTO queue_jobs (topic, payload, idempotency_key) VALUES ('deep_water.brief.action', $1, $2)`,
    [JSON.stringify({ organizationId: fixture.ids.organization, runId: running }), `deep-water-brief-action:${running}:${enqueuedId}`],
  )
  assert.equal(await begin(fixture, running, enqueuedId), 'replay')

  const record = (id: string) => fixture.prisma.$transaction((tx) => recordLegacyDeepWaterCancel(tx, {
    organizationId: fixture.ids.organization,
    runId: running,
    researchId: id,
  }))
  assert.equal(await record('rs_someotherresearch'), false, 'a different research never moves the run')
  assert.equal(await record(researchId), true)
  assert.equal(await statusOf(fixture, running), 'cancelled')
  assert.equal(await record(researchId), false, 'a late job finds it already cancelled')
  assert.equal(await begin(fixture, running, enqueuedId), 'replay', 'still a replay once Ledger agreed')
})

withFixture('a research brief is not a launcher run, and its research id finds it in its own team only', async (fixture) => {
  const { run } = await insertBrief(fixture)
  assert.equal(await begin(fixture, run.id), null)
  const researchId = 'rs_brieflookup1'
  await fixture.pool.query('UPDATE product_integration_runs SET external_run_id = $2 WHERE id = $1', [run.id, researchId])
  const found = await findDeepWaterBriefRunByResearchId(fixture.prisma, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
    researchId,
  })
  assert.equal(found?.id, run.id)
  const otherTeam = await findDeepWaterBriefRunByResearchId(fixture.prisma, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.project,
    researchId,
  })
  assert.equal(otherTeam, null)
})
