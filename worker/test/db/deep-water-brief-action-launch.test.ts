import assert from 'node:assert/strict'

import { ResearchRunRefMessageMetadataSchema } from '@nessie/schemas'

import { withActionFixture } from './deep-water-brief-action-fixture.js'

/**
 * A person's Start in the worker (Water plan nessie.md §7.3, amendments L3): a
 * launch posts the person's research card once, and a launch Ledger reverts
 * moves the run back to drafting. Cancels are in `deep-water-brief-action-cancel.test.ts`.
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
