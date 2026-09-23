import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyDeepWaterScopeResult } from '../src/deepwater-brief-projection.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import { DeepWaterBriefRunUpdateRefusedError, updateDeepWaterResearchRun } from '../src/integration-runs.js'
import {
  agentOrigin,
  insertBrief,
  personOrigin,
  seedBriefFixture,
  type BriefFixture,
} from './deepwater-brief-fixture.js'

/**
 * `deep_water_run_update` (the launcher's agent updater, retired in phase E)
 * against research briefs: a brief's status and research id are Ledger's
 * (contract §2.3 invariant 6), so the updater refuses every brief row by name
 * and changes nothing — an agent writing `completed` onto a brief would end
 * the watch before the research was ever delivered. Launcher rows keep their
 * updater (integration-runs-immutability.test.ts).
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

const update = (fixture: BriefFixture, runId: string, fields: { status?: 'completed' | 'failed'; externalRunId?: string }) =>
  updateDeepWaterResearchRun(fixture.prisma, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
    threadId: fixture.ids.thread,
    runId,
    ...fields,
  })

withFixture('the launcher updater refuses a brief row and leaves it to Ledger', async (fixture) => {
  const { run: attached } = await insertBrief(fixture, personOrigin())
  const rs = researchId()
  await fixture.prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
    organizationId: fixture.ids.organization,
    runId: attached.id,
    result: {
      id: rs,
      status: 'running',
      errorCode: null,
      title: null,
      brief: null,
      turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
    },
  }))
  await assert.rejects(update(fixture, attached.id, { status: 'completed' }), DeepWaterBriefRunUpdateRefusedError)
  const stillRunning = await readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId: attached.id })
  assert.equal(stillRunning?.status, 'running')
  assert.equal(stillRunning?.completedAt, null)

  // An agent's brief whose start was never acknowledged cannot be given a research id either.
  const { run: unattached } = await insertBrief(fixture, agentOrigin(fixture))
  await assert.rejects(
    update(fixture, unattached.id, { externalRunId: researchId(), status: 'failed' }),
    (error: unknown) => error instanceof DeepWaterBriefRunUpdateRefusedError
      && error.code === 'DEEP_WATER_BRIEF_RUN_LEDGER_OWNED'
      && /research_status/.test(error.message),
  )
  const untouched = await readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId: unattached.id })
  assert.equal(untouched?.externalRunId, null)
  assert.equal(untouched?.status, 'queued')
})
