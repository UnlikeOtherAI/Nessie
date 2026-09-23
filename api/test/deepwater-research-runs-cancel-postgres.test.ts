import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { applyDeepWaterStatusRead, createDeepWaterResearchRun } from '@nessie/runtime'
import { DeepWaterResearchLaunchRequestSchema, LedgerResearchStatusDtoSchema } from '@nessie/schemas'

import { LedgerDeepWaterActiveRunsError, removeDeepWaterTeamInstance } from '../src/services/deepwater-activation.js'
import {
  RUNS,
  drafted,
  open,
  openingGaveUp,
  signInOwner,
  withBriefApi,
  type BriefApiFixture,
} from './deepwater-research-runs-fixture.js'

/**
 * Cancelling research from the brief API (Water plan amendments N8.5, N9.6,
 * amendments-fable F3): a team owner or admin can clear any open research in
 * their team — a brief DeepWater has not named yet included — so a disable it
 * blocks always has a remedy; a cancel is answered once per actionId; and
 * whoever cancels is on the audit when DeepWater keeps no record of it.
 */

const team = (fixture: BriefApiFixture) => ({ organizationId: fixture.ids.organization, teamId: fixture.ids.team })

const cancel = (fixture: BriefApiFixture, runId: string, actionId: string = randomUUID()) =>
  fixture.request('POST', `${RUNS}/${runId}/cancel`, { actionId })

const audits = (fixture: BriefApiFixture) => fixture.prisma.auditLog.findMany({
  where: { organizationId: fixture.ids.organization, action: 'integration.research.cancelled' },
})

const canCancel = async (fixture: BriefApiFixture, runId: string) =>
  ((await fixture.request('GET', `${RUNS}/${runId}`)).body.data?.viewer as { canCancel: boolean }).canCancel

withBriefApi('a brief DeepWater never named is cancelled here once nothing can open it, releasing a disable', async (fixture) => {
  const { runId } = await open(fixture)
  // Its opening job may be at DeepWater right now: no Cancel yet, and the route agrees.
  assert.equal(await canCancel(fixture, runId), false)
  const opening = await cancel(fixture, runId)
  assert.equal(opening.statusCode, 409)
  assert.equal(opening.body.error?.code, 'DEEP_WATER_BRIEF_BUSY')

  // DeepWater stayed unreachable and the job gave up: the brief still holds the connector.
  await openingGaveUp(fixture, runId)
  assert.equal(await canCancel(fixture, runId), true)
  await assert.rejects(removeDeepWaterTeamInstance(fixture.prisma, team(fixture)), (error: unknown) =>
    error instanceof LedgerDeepWaterActiveRunsError && error.run.id === runId)

  // An owner who cannot read it clears it, with no DeepWater identity needed.
  fixture.actAs('owner')
  const actionId = randomUUID()
  const cancelled = await cancel(fixture, runId, actionId)
  assert.equal(cancelled.statusCode, 202)
  assert.deepEqual(cancelled.body.data, { id: runId, status: 'cancelled' })
  assert.equal((await fixture.briefJobs(runId)).length, 1, 'only the opening: nothing is sent to DeepWater')
  const [audit] = await audits(fixture)
  assert.equal(audit?.actorId, fixture.ids.owner)
  assert.equal((audit?.metadata as { via?: string } | null)?.via, 'unopened_local')

  const replay = await cancel(fixture, runId, actionId)
  assert.equal(replay.statusCode, 200, 'a retry whose answer was lost is a replay')
  assert.equal((await audits(fixture)).length, 1)
  assert.equal((await cancel(fixture, runId)).body.error?.code, 'DEEP_WATER_RUN_NOT_CANCELLABLE')

  const removed = await removeDeepWaterTeamInstance(fixture.prisma, team(fixture))
  assert.equal(removed.instanceId, fixture.ids.connector)
})

withBriefApi('an owner\'s cancel of a named brief goes to DeepWater as the owner, and its answer releases a disable', async (fixture) => {
  const { runId } = await open(fixture)
  await drafted(fixture, runId)
  await assert.rejects(removeDeepWaterTeamInstance(fixture.prisma, team(fixture)), LedgerDeepWaterActiveRunsError)

  const ownerIdentity = await signInOwner(fixture)
  const cancelled = await cancel(fixture, runId)
  assert.equal(cancelled.statusCode, 202)
  const job = (await fixture.briefJobs(runId)).find((row) => (row.payload.action as { kind: string }).kind === 'cancel')
  assert.deepEqual(job?.payload.actor, { userId: fixture.ids.owner, role: 'owner', identity: ownerIdentity })
  assert.equal(typeof job?.payload.acceptedAt, 'string', 'the retry window runs from acceptance')

  // The worker's research_cancel answer, as it applies it.
  const run = await fixture.prisma.productIntegrationRun.findUniqueOrThrow({ where: { id: runId } })
  await fixture.prisma.$transaction((tx) => applyDeepWaterStatusRead(tx, {
    organizationId: fixture.ids.organization,
    runId,
    status: LedgerResearchStatusDtoSchema.parse({
      id: run.externalRunId, status: 'cancelled', title: null, error_code: 'cancelled_by_owner',
    }),
  }))
  const removed = await removeDeepWaterTeamInstance(fixture.prisma, team(fixture))
  assert.equal(removed.instanceId, fixture.ids.connector)
})

withBriefApi('a launcher run is cancelled through DeepWater once per action, with the owner on the audit', async (fixture) => {
  const launcher = await createDeepWaterResearchRun(fixture.prisma, {
    connectorId: fixture.ids.connector,
    input: DeepWaterResearchLaunchRequestSchema.parse({ query: 'Launcher research' }),
    organizationId: fixture.ids.organization,
    requestedByUserId: fixture.ids.requester,
    teamId: fixture.ids.team,
  })
  await fixture.prisma.productIntegrationRun.update({
    where: { id: launcher.id },
    data: { status: 'running', externalRunId: `rs_${randomUUID().replaceAll('-', '')}` },
  })

  // Its requester's way out is the chat it was handed to; only an owner or admin clears it here.
  const requester = await cancel(fixture, launcher.id)
  assert.equal(requester.body.error?.code, 'DEEP_WATER_RUN_NOT_CANCELLABLE')

  const ownerIdentity = await signInOwner(fixture)
  const actionId = randomUUID()
  const accepted = await cancel(fixture, launcher.id, actionId)
  assert.equal(accepted.statusCode, 202)
  const jobs = await fixture.briefJobs(launcher.id)
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0]?.payload.actor, { userId: fixture.ids.owner, role: 'owner', identity: ownerIdentity })
  const [audit] = await audits(fixture)
  assert.equal(audit?.actorId, fixture.ids.owner)
  assert.equal(audit?.resourceId, launcher.id)
  assert.equal((audit?.metadata as { via?: string } | null)?.via, 'launcher_ledger')

  const replay = await cancel(fixture, launcher.id, actionId)
  assert.equal(replay.statusCode, 200)
  assert.equal((await fixture.briefJobs(launcher.id)).length, 1, 'a replay enqueues nothing')
  assert.equal((await audits(fixture)).length, 1)
})
