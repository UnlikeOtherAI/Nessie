import assert from 'node:assert/strict'

import { createDeepWaterResearchRun } from '@nessie/runtime'
import { DeepWaterResearchLaunchRequestSchema, ResearchRunRefMessageMetadataSchema } from '@nessie/schemas'

import { withActionFixture } from './deep-water-brief-action-fixture.js'
import { researchId } from './deep-water-watch-fixture.js'

/**
 * A person's Start and Cancel in the worker (Water plan nessie.md §7.3,
 * amendments L3, N8.5, N9.6, amendments-fable F3): a launch posts the person's
 * research card once, a launch Ledger reverts moves the run back to drafting,
 * an owner cancels with their own identity, and a launcher run is cancelled
 * through Ledger and recorded once Ledger agrees.
 */

withActionFixture('Start launches the agreed brief and posts the person\'s research card once', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const launch = await fixture.begin(run, { kind: 'launch', revision: 1, public: true })
  fixture.ledger.answer('research_scope_launch', { id: rs, job_id: rs, status: 'running' })

  await fixture.perform(launch)
  await fixture.perform(launch)

  const [call] = fixture.ledger.calls
  assert.deepEqual(call?.args, { id: rs, revision: 1, public: true })
  assert.equal(fixture.ledger.calls.length, 1, 'a settled launch is not sent again')
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'running')
  assert.ok(after.launchedAt)
  assert.equal(after.scopeState?.pendingAction, null)
  const cards = (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread } }))
    .filter((message) => ResearchRunRefMessageMetadataSchema.safeParse(message.metadata).success)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.id, after.cardMessageId)
  assert.equal(cards[0]?.role, 'user')
  assert.equal(cards[0]?.userId, fixture.ids.requester)
})

withActionFixture('a private Start sends no public flag', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const launch = await fixture.begin(run, { kind: 'launch', revision: 1, pillars: ['Costs'], public: false })
  fixture.ledger.answer('research_scope_launch', { id: rs, job_id: rs, status: 'running' })
  await fixture.perform(launch)
  assert.deepEqual(fixture.ledger.calls[0]?.args, { id: rs, revision: 1, pillars: ['Costs'] })
})

withActionFixture('a launch Ledger refuses on the brief moves the run back to drafting', async (fixture) => {
  const { run } = await fixture.openBrief()
  const launch = await fixture.begin(run, { kind: 'launch', revision: 1, public: false })
  // A watch read saw the research starting before Ledger reverted it.
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { status: 'running', launchedAt: new Date() },
  })
  fixture.ledger.answer('research_scope_launch', { error: 'scope_revision_conflict', status_code: 409, current_revision: 2 }, false)

  await fixture.perform(launch)

  const after = await fixture.read(run.id)
  assert.equal(after.status, 'drafting')
  assert.equal(after.launchedAt, null)
  assert.equal(after.scopeState?.pendingAction?.error?.code, 'revision_conflict')
})

withActionFixture('a person cancels their own brief as themselves', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const cancel = await fixture.begin(run, { kind: 'cancel' })
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled' })
  await fixture.perform(cancel)
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'cancelled')
  assert.equal(after.scopeState?.pendingAction, null)
  assert.equal(fixture.attributions[0]?.systemComponent, 'deep-water.brief')
  assert.deepEqual(fixture.ledger.calls[0]?.args, { id: rs })
})

withActionFixture('an owner cancels someone else\'s research with their own identity', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const owner = await fixture.prisma.user.create({ data: { displayName: 'Owner', email: `owner-${rs}@example.test` } })
  await fixture.prisma.organizationMember.create({
    data: { organizationId: fixture.ids.organization, userId: owner.id, role: 'owner' },
  })
  const ownerIdentity = { ...fixture.identity, subject: `uoa|${owner.id}`, tokenVersion: 7 }
  const cancel = await fixture.begin(run, { kind: 'cancel' }, { userId: owner.id, role: 'owner', identity: ownerIdentity })
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled_by_owner' })

  await fixture.perform(cancel)

  const [signed] = fixture.attributions
  assert.equal(signed?.systemComponent, 'deep-water.owner-cancel')
  assert.equal(signed?.userId, owner.id)
  assert.deepEqual(signed?.uoaIdentity, ownerIdentity)
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'cancelled')
  assert.deepEqual(after.uoaIdentity, fixture.identity, 'an owner never re-addresses the requester\'s capture')
  await fixture.prisma.user.deleteMany({ where: { id: owner.id } })
})

withActionFixture('a launcher run is cancelled through Ledger and recorded once Ledger agrees', async (fixture) => {
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
  const legacy = await fixture.read(created.id)
  assert.equal(legacy.scopeState, null)
  const job = {
    organizationId: legacy.organizationId,
    runId: legacy.id,
    actionId: '3f0f3a7e-8c55-4d2f-9f6b-0d2a4bd1c001',
    actor: { userId: fixture.ids.requester, role: 'owner' as const, identity: fixture.identity },
    action: { kind: 'cancel' as const },
  }
  fixture.ledger.answer('research_cancel', { id: rs, status: 'cancelled', title: null, error_code: 'cancelled_by_owner' })

  await fixture.perform(job)

  assert.equal(fixture.attributions[0]?.systemComponent, 'deep-water.owner-cancel')
  assert.equal((await fixture.read(created.id)).status, 'cancelled')
})
