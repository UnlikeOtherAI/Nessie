import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { QueueRetryAfterError } from '@nessie/runtime'

import { withActionFixture } from './deep-water-brief-action-fixture.js'
import { researchId, wireScope } from './deep-water-watch-fixture.js'

/**
 * A person's brief action in the worker (Water plan nessie.md §7.3, contract
 * D10, amendments N5, L3, amendments-fable F4): the one Ledger call the action
 * stands for, signed as the person with the live identity the request carried,
 * under a tool-call id that is stable across retries; the answer applied
 * through the shared projection; a refusal ending the action with its code; a
 * transient failure retried with the same call for at most 30 minutes.
 */

withActionFixture('opening a brief sends the brief as opened, as the person, and binds the research', async (fixture) => {
  const run = await fixture.insert('person')
  const opening = fixture.opening(run)
  const rs = researchId()
  const turnId = randomUUID()
  fixture.ledger.answer('research_scope_start', wireScope({
    id: rs,
    revision: 0,
    turn: { id: turnId, seq: 1, status: 'pending', author_kind: 'person' },
  }))

  await fixture.perform(opening)

  assert.equal(fixture.ledger.calls.length, 1)
  const [call] = fixture.ledger.calls
  assert.equal(call?.toolName, 'research_scope_start')
  assert.equal(call?.toolCallId, `brief:${run.id}:${opening.actionId}`)
  assert.deepEqual(call?.args, { topic: 'Heat pumps in older houses', settings: { depth: 'light' } })
  const [signed] = fixture.attributions
  assert.equal(signed?.systemComponent, 'deep-water.brief')
  assert.equal(signed?.agentKind, null)
  assert.equal(signed?.userId, fixture.ids.requester)
  assert.equal(signed?.runId, run.id)
  assert.deepEqual(signed?.uoaIdentity, fixture.identity)

  const after = await fixture.read(run.id)
  assert.equal(after.status, 'drafting')
  assert.equal(after.externalRunId, rs)
  assert.equal(after.scopeState?.pendingAction?.turnId, turnId, 'the action waits for its own planner turn')
  assert.equal(after.scopeState?.pendingAction?.error, null)
  assert.deepEqual(after.scopeState?.turnAuthors[turnId], { kind: 'person', userId: fixture.ids.requester })
})

withActionFixture('a brief Ledger refuses to open fails with the refusal, and a lost sign-in says so', async (fixture) => {
  const refused = await fixture.insert('person')
  fixture.ledger.answer('research_scope_start', { error: 'scope_limit', status_code: 409 }, false)
  await fixture.perform(fixture.opening(refused))
  const failed = await fixture.read(refused.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failureCode, 'scope_limit')
  assert.equal(failed.scopeState?.pendingAction?.error?.code, 'brief_limit')

  const unsigned = await fixture.insert('person')
  fixture.failIdentity(true)
  await fixture.perform(fixture.opening(unsigned))
  const noIdentity = await fixture.read(unsigned.id)
  assert.equal(noIdentity.status, 'failed')
  assert.equal(noIdentity.failureCode, 'identity_unavailable')
  assert.equal(noIdentity.scopeState?.pendingAction?.error?.code, 'identity_required')
  assert.equal(fixture.ledger.calls.length, 1, 'nothing reached Ledger without a signed identity')
})

withActionFixture('a reply sends its edits in Ledger\'s words and renews the requester\'s sign-in', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  // The watch stopped on a changed sign-in; the person acting again is the remedy.
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { deliveryBlockedReason: 'requester_identity_changed' },
  })
  const renewed = { ...fixture.identity, tokenVersion: fixture.identity.tokenVersion + 1 }
  const reply = await fixture.begin(run, {
    kind: 'reply',
    message: 'Focus on the UK.',
    baseRevision: 1,
    pillars: ['Costs in the UK'],
    settings: { outputLanguage: 'cs', recency: null },
  }, { userId: fixture.ids.requester, role: 'requester', identity: renewed })
  const turnId = randomUUID()
  fixture.ledger.answer('research_scope_reply', wireScope({
    id: rs,
    revision: 2,
    turn: { id: turnId, seq: 2, status: 'pending', author_kind: 'person' },
  }))

  await fixture.perform(reply)

  const [call] = fixture.ledger.calls
  assert.deepEqual(call?.args, {
    id: rs,
    message: 'Focus on the UK.',
    base_revision: 1,
    pillars: ['Costs in the UK'],
    settings: { output_language: 'cs', recency: null },
  })
  const after = await fixture.read(run.id)
  assert.equal(after.scopeState?.pendingAction?.turnId, turnId)
  assert.equal(after.scopeState?.brief?.revision, 2)
  assert.deepEqual(after.uoaIdentity, renewed)
  assert.equal(after.deliveryBlockedReason, null)
})

withActionFixture('a refused reply ends the action with the refusal\'s code', async (fixture) => {
  const { run, rs } = await fixture.openBrief()
  const reply = await fixture.begin(run, { kind: 'reply', message: 'Once more.' })
  fixture.ledger.answer('research_scope_reply', { error: 'scope_busy', status_code: 409 }, false)
  await fixture.perform(reply)
  const after = await fixture.read(run.id)
  assert.equal(after.status, 'drafting')
  assert.equal(after.externalRunId, rs)
  assert.equal(after.scopeState?.pendingAction?.actionId, reply.actionId)
  assert.equal(after.scopeState?.pendingAction?.error?.code, 'busy')
})

withActionFixture('an unreachable Ledger is retried with the same call, for 30 minutes', async (fixture) => {
  const { run } = await fixture.openBrief()
  const reply = await fixture.begin(run, { kind: 'reply', message: 'Are you there?' })
  fixture.ledger.answer('research_scope_reply', { error: 'upstream_unavailable', status_code: 503 }, false)
  await assert.rejects(fixture.perform(reply), (error: unknown) => error instanceof QueueRetryAfterError)
  await assert.rejects(fixture.perform(reply), (error: unknown) => error instanceof QueueRetryAfterError)
  const [first, second] = fixture.ledger.calls
  assert.equal(first?.toolCallId, second?.toolCallId, 'a retry replays the same call')
  assert.equal((await fixture.read(run.id)).scopeState?.pendingAction?.error, null, 'still in flight')

  // The person acted more than 30 minutes ago: the action ends, and nothing is sent.
  const state = (await fixture.read(run.id)).scopeState
  const action = state?.pendingAction
  assert.ok(state && action)
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      scopeJson: { ...state, pendingAction: { ...action, since: new Date(Date.now() - 31 * 60_000).toISOString() } },
    },
  })
  await fixture.perform(reply)
  assert.equal(fixture.ledger.calls.length, 2)
  assert.equal((await fixture.read(run.id)).scopeState?.pendingAction?.error?.code, 'unavailable')
})

withActionFixture('an action already ended by a read or a cancel is not sent', async (fixture) => {
  const { run } = await fixture.openBrief()
  const reply = await fixture.begin(run, { kind: 'reply', message: 'First thought.' })
  const cancel = await fixture.begin(await fixture.read(run.id), { kind: 'cancel' })
  await fixture.perform(reply)
  assert.equal(fixture.ledger.calls.length, 0)
  assert.equal((await fixture.read(run.id)).scopeState?.pendingAction?.actionId, cancel.actionId)
})
