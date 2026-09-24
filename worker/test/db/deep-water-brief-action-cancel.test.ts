import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  QueueRetryAfterError,
  beginLegacyDeepWaterCancel,
  createDeepWaterResearchRun,
  toDeepWaterResearchRunView,
  type DeepWaterBriefRun,
} from '@nessie/runtime'
import { DeepWaterResearchLaunchRequestSchema, type DeepWaterBriefActionJobPayload } from '@nessie/schemas'

import { withActionFixture, type ActionFixture } from './deep-water-brief-action-fixture.js'
import { researchId } from './deep-water-watch-fixture.js'

/**
 * A cancel in the worker (Water plan nessie.md §7.3, amendments N8.5, N9.6,
 * amendments-fable F3): a person cancels as themselves and an owner with their
 * own identity; a launcher run is cancelled through Ledger and recorded once
 * Ledger agrees. An owner's cancel is audited with what Ledger did — never on
 * acceptance alone — and a launcher cancel that did not go through is written
 * on the run, so its view says why it is still open.
 */

const cancelAudits = (fixture: ActionFixture) => fixture.prisma.auditLog.findMany({
  where: { organizationId: fixture.ids.organization, action: 'integration.research.cancelled' },
  orderBy: { createdAt: 'asc' },
})

const addOwner = async (fixture: ActionFixture, tag: string) => {
  const owner = await fixture.prisma.user.create({ data: { displayName: 'Owner', email: `owner-${tag}@example.test` } })
  await fixture.prisma.organizationMember.create({
    data: { organizationId: fixture.ids.organization, userId: owner.id, role: 'owner' },
  })
  const identity = { ...fixture.identity, subject: `uoa|${owner.id}`, tokenVersion: 7 }
  return { owner, identity, actor: { userId: owner.id, role: 'owner' as const, identity } }
}

/** A running launcher run with a research id, and an owner's cancel of it accepted as the API accepts it. */
const launcherCancel = async (
  fixture: ActionFixture,
  acceptedAt: string = new Date().toISOString(),
): Promise<{ run: DeepWaterBriefRun; rs: string; job: DeepWaterBriefActionJobPayload }> => {
  const created = await createDeepWaterResearchRun(fixture.prisma, {
    connectorId: fixture.ids.connector,
    input: DeepWaterResearchLaunchRequestSchema.parse({ query: 'Launcher research' }),
    organizationId: fixture.ids.organization,
    requestedByUserId: fixture.ids.requester,
    teamId: fixture.ids.team,
  })
  const rs = researchId()
  await fixture.prisma.productIntegrationRun.update({
    where: { id: created.id },
    data: { status: 'running', externalRunId: rs, channelId: fixture.ids.channel, threadId: fixture.ids.thread },
  })
  const actionId = randomUUID()
  const route = await fixture.prisma.$transaction((tx) => beginLegacyDeepWaterCancel(tx, {
    organizationId: fixture.ids.organization, runId: created.id, actionId,
  }))
  assert.equal(route, 'ledger')
  const run = await fixture.read(created.id)
  assert.equal(run.scopeState, null)
  const job = {
    organizationId: run.organizationId,
    runId: run.id,
    actionId,
    acceptedAt,
    actor: { userId: fixture.ids.requester, role: 'owner' as const, identity: fixture.identity },
    action: { kind: 'cancel' as const },
  }
  return { run, rs, job }
}

const viewOf = (run: DeepWaterBriefRun) =>
  toDeepWaterResearchRunView(run, { viewer: { userId: randomUUID(), canChangeTeam: true }, reportSpaceId: null, now: new Date() })

withActionFixture('a person cancels their own brief as themselves, and it is theirs on Ledger\'s record', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const cancel = await fixture.begin(run, { kind: 'cancel' })
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled' })
  await fixture.perform(cancel)
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'cancelled')
  assert.equal(after.scopeState?.pendingAction, null)
  assert.equal(fixture.attributions[0]?.systemComponent, 'deep-water.brief')
  assert.deepEqual(fixture.ledger.calls[0]?.args, { id: rs })
  assert.deepEqual(await cancelAudits(fixture), [], 'a requester cancelling their own brief is not an owner\'s act')
})

withActionFixture('an owner cancels someone else\'s research with their own identity, audited once Ledger agrees', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const { owner, identity, actor } = await addOwner(fixture, rs)
  const cancel = await fixture.begin(run, { kind: 'cancel' }, actor)
  assert.deepEqual(await cancelAudits(fixture), [], 'accepting a cancel is not cancelling')
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled_by_owner' })

  await fixture.perform(cancel)

  const [signed] = fixture.attributions
  assert.equal(signed?.systemComponent, 'deep-water.owner-cancel')
  assert.equal(signed?.userId, owner.id)
  assert.deepEqual(signed?.uoaIdentity, identity)
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'cancelled')
  assert.deepEqual(after.uoaIdentity, fixture.identity, 'an owner never re-addresses the requester\'s capture')
  const audits = await cancelAudits(fixture)
  assert.deepEqual(audits.map((row) => [row.actorId, row.resourceId, row.outcome]), [[owner.id, run.id, 'success']])
  await fixture.prisma.user.deleteMany({ where: { id: owner.id } })
})

withActionFixture('an owner\'s cancel Ledger refuses is audited as denied, and the run says why it is open', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const { owner, actor } = await addOwner(fixture, rs)
  const cancel = await fixture.begin(run, { kind: 'cancel' }, actor)
  fixture.ledger.answer('research_cancel', { error: 'owner_role_required', status_code: 403 }, false)

  await fixture.perform(cancel)

  const after = await fixture.read(run.id)
  assert.equal(after.status, 'drafting')
  assert.equal(viewOf(after).cancelFailure?.code, 'forbidden')
  const [audit] = await cancelAudits(fixture)
  assert.deepEqual([audit?.actorId, audit?.outcome, audit?.reason], [owner.id, 'denied', 'owner_role_required'])
  await fixture.prisma.user.deleteMany({ where: { id: owner.id } })
})

withActionFixture('a launcher run is cancelled through Ledger, recorded once Ledger agrees, and audited then', async (fixture) => {
  const { run, rs, job } = await launcherCancel(fixture)
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled_by_owner' })

  await fixture.perform(job)

  assert.equal(fixture.attributions[0]?.systemComponent, 'deep-water.owner-cancel')
  assert.equal((await fixture.read(run.id)).status, 'cancelled')
  const [audit] = await cancelAudits(fixture)
  assert.deepEqual([audit?.outcome, (audit?.metadata as { via?: string } | null)?.via], ['success', 'launcher_ledger'])
})

withActionFixture('a launcher cancel that has its answer, or that a newer one replaced, is not sent again', async (fixture) => {
  const { run, rs, job } = await launcherCancel(fixture)
  fixture.ledger.answer('research_cancel', { error: 'forbidden', status_code: 403 }, false)
  await fixture.perform(job)
  // Redelivered after its answer was recorded: nothing is sent, nothing audited twice.
  await fixture.perform(job)
  assert.equal(fixture.ledger.calls.length, 1)
  assert.equal((await cancelAudits(fixture)).length, 1)

  // The owner tries again; the first job, redelivered once more, stays quiet.
  const again = randomUUID()
  assert.equal(await fixture.prisma.$transaction((tx) => beginLegacyDeepWaterCancel(tx, {
    organizationId: fixture.ids.organization, runId: run.id, actionId: again,
  })), 'ledger')
  assert.equal(viewOf(await fixture.read(run.id)).cancelFailure, null, 'a new cancel is on its way')
  await fixture.perform(job)
  assert.equal(fixture.ledger.calls.length, 1)
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled_by_owner' })
  await fixture.perform({ ...job, actionId: again })
  assert.equal((await fixture.read(run.id)).status, 'cancelled')
  assert.deepEqual((await cancelAudits(fixture)).map((row) => row.outcome), ['denied', 'success'])
})

withActionFixture('a launcher cancel Ledger refuses leaves the run open, says why on it, and is audited as denied', async (fixture) => {
  const { run, job } = await launcherCancel(fixture)
  fixture.ledger.answer('research_cancel', { error: 'forbidden', status_code: 403 }, false)

  await fixture.perform(job)

  const after = await fixture.read(run.id)
  assert.equal(after.status, 'running', 'still open: it still blocks a disable, and its owner can try again')
  assert.deepEqual(after.launcher?.ledgerCancel && { ...after.launcher.ledgerCancel, at: null }, {
    actionId: job.actionId, state: 'failed', code: 'forbidden', at: null,
  })
  const view = viewOf(after)
  assert.equal(view.cancelFailure?.code, 'forbidden')
  assert.equal(view.viewer.canCancel, true)
  const [audit] = await cancelAudits(fixture)
  assert.deepEqual([audit?.outcome, audit?.reason], ['denied', 'forbidden'])
})

withActionFixture('a launcher cancel stops retrying 30 minutes after it was accepted, and says so on the run', async (fixture) => {
  const { run, job } = await launcherCancel(fixture, new Date(Date.now() - 29 * 60_000).toISOString())
  fixture.ledger.answer('research_cancel', { error: 'upstream_unavailable', status_code: 503 }, false)

  // Each retry is a fresh attempt the queue re-dated; the window still runs from acceptance.
  await assert.rejects(fixture.perform(job), (error: unknown) => error instanceof QueueRetryAfterError)
  await assert.rejects(fixture.perform(job), (error: unknown) => error instanceof QueueRetryAfterError)
  assert.equal(fixture.ledger.calls.length, 2)
  assert.deepEqual(await cancelAudits(fixture), [], 'a retry is not an outcome')

  await fixture.perform({ ...job, acceptedAt: new Date(Date.now() - 31 * 60_000).toISOString() })
  assert.equal(fixture.ledger.calls.length, 2, 'past the window nothing is sent')
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'running', 'the run is left for its owner to cancel again')
  assert.equal(viewOf(after).cancelFailure?.code, 'unavailable')
  const [audit] = await cancelAudits(fixture)
  assert.deepEqual([audit?.outcome, audit?.reason], ['error', 'ledger_unreachable'])
})
