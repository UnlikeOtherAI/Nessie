import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepWaterResearchLaunchRequestSchema } from '@nessie/schemas'

import { applyDeepWaterScopeResult } from '../src/deepwater-brief-projection.js'
import { createDeepWaterResearchRun, listDeepWaterResearchRuns } from '../src/integration-runs.js'
import {
  agentOrigin,
  insertBrief,
  personOrigin,
  seedBriefFixture,
  type BriefFixture,
} from './deepwater-brief-fixture.js'

/**
 * The legacy run list (`GET …/:productSlug/research-runs`, Knowledge ›
 * Research) reads the whole team with no viewer predicate, so it may only ever
 * hold launcher rows. A research brief carries its requester's topic from the
 * moment it is opened and a person's brief is theirs alone until it launches
 * (Water plan amendments N6): a brief row in this list would show a colleague's
 * unlaunched brief, from their Personal Assistant or a private channel, to the
 * whole team.
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

withFixture('the legacy run list holds launcher rows only, never a research brief', async (fixture) => {
  const launcher = await createDeepWaterResearchRun(fixture.prisma, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
    connectorId: fixture.ids.connector,
    requestedByUserId: fixture.ids.requester,
    input: DeepWaterResearchLaunchRequestSchema.parse({ query: 'Launcher research on heat pumps' }),
  })

  // A person's brief still being agreed, and an agent's brief the planner answered.
  await insertBrief(fixture, personOrigin())
  const { run: agentBrief } = await insertBrief(fixture, agentOrigin(fixture))
  await fixture.prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
    organizationId: fixture.ids.organization,
    runId: agentBrief.id,
    result: {
      id: `rs_${randomUUID().replaceAll('-', '')}`,
      status: 'drafting',
      errorCode: null,
      title: null,
      brief: null,
      turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'agent', errorCode: null, retryable: false },
    },
  }))
  assert.equal(
    await fixture.prisma.productIntegrationRun.count({ where: { organizationId: fixture.ids.organization } }),
    3,
    'the team holds one launcher run and two briefs',
  )

  const listed = await listDeepWaterResearchRuns(fixture.prisma, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
  })
  assert.deepEqual(listed.map((run) => run.id), [launcher.id])
  assert.equal(listed[0]?.queryPreview, 'Launcher research on heat pumps')
})
