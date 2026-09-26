import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOneOnOnePlanBlock,
  earlierThreadRoot,
  isMarkedDone,
  readOneOnOnePlan,
} from './one-on-one-plan.js'

const AGENT_ID = '00000000-0000-4000-8000-0000000000e1'
const OTHER_AGENT_ID = '00000000-0000-4000-8000-0000000000e2'
const PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000e3'
const EARLIER_ID = '00000000-0000-4000-8000-0000000000e4'

const snapshot = (decisions: unknown[], policyFingerprint = 'one-on-one') => ({
  policyFingerprint,
  authorizer: null,
  basisScopes: [],
  disclosureSources: [],
  decisions,
})

test('the plan is read for this exact agent from a one-on-one snapshot', () => {
  const pinned = snapshot([
    { action: 'reply', agentId: OTHER_AGENT_ID, replyPlacement: 'channel', acknowledgeWhenDone: true },
    {
      action: 'reply', agentId: AGENT_ID, replyPlacement: 'thread',
      earlierMessageId: EARLIER_ID, earlierReference: 'thread',
    },
  ])
  assert.deepEqual(readOneOnOnePlan(pinned, { agentId: AGENT_ID, principalUserId: null }), {
    acknowledgeWhenDone: false,
    earlier: { messageId: EARLIER_ID, reference: 'thread' },
  })
})

test('a principal must match, so one person’s assistant never reads another’s plan', () => {
  const pinned = snapshot([{
    action: 'reply', agentId: AGENT_ID, principalUserId: PRINCIPAL_ID,
    replyPlacement: 'channel', acknowledgeWhenDone: true,
  }])
  assert.equal(readOneOnOnePlan(pinned, { agentId: AGENT_ID, principalUserId: null }), undefined)
  assert.deepEqual(
    readOneOnOnePlan(pinned, { agentId: AGENT_ID, principalUserId: PRINCIPAL_ID }),
    { acknowledgeWhenDone: true },
  )
})

test('a channel policy’s snapshot, none, or a malformed one is no plan', () => {
  const target = { agentId: AGENT_ID }
  const policy = snapshot([{ action: 'reply', agentId: AGENT_ID, acknowledgeWhenDone: true }], 'sha256-of-a-policy')
  assert.equal(readOneOnOnePlan(policy, target), undefined)
  assert.equal(readOneOnOnePlan(null, target), undefined)
  assert.equal(readOneOnOnePlan({ decisions: 'nope' }, target), undefined)
})

test('only a thread reference moves the answer under the earlier message', () => {
  assert.equal(earlierThreadRoot(undefined), undefined)
  assert.equal(earlierThreadRoot({ acknowledgeWhenDone: false }), undefined)
  for (const reference of ['mention', 'link'] as const) {
    const plan = { acknowledgeWhenDone: false, earlier: { messageId: EARLIER_ID, reference } }
    assert.equal(earlierThreadRoot(plan), undefined)
  }
  assert.equal(
    earlierThreadRoot({ acknowledgeWhenDone: false, earlier: { messageId: EARLIER_ID, reference: 'thread' } }),
    EARLIER_ID,
  )
})

test('work with nothing worth reading is marked done, unless the agent reacted itself', () => {
  const act = { acknowledgeWhenDone: true }
  assert.equal(isMarkedDone(act, false, ''), true)
  assert.equal(isMarkedDone(act, false, ' ✅ '), true)
  // Words carry information: they are the answer, and they are posted.
  assert.equal(isMarkedDone(act, false, 'Hotovo, přidal jsem mléko.'), false)
  assert.equal(isMarkedDone(act, false, '3 items added'), false)
  // The agent's own reaction is already the mark.
  assert.equal(isMarkedDone(act, true, ''), false)
  // Nothing to mark without a plan that asked for it.
  assert.equal(isMarkedDone(undefined, false, ''), false)
  assert.equal(isMarkedDone({ acknowledgeWhenDone: false }, false, ''), false)
})

test('the prompt names the earlier message from the admitted transcript and says where the reply goes', () => {
  const block = buildOneOnOnePlanBlock(
    { acknowledgeWhenDone: false, earlier: { messageId: EARLIER_ID, reference: 'thread' } },
    'launch je 12. října,\n   zapamatuj si to',
  )
  assert.ok(block)
  assert.match(block, /goes back to an earlier message in this chat: “launch je 12\. října, zapamatuj si to”\./)
  assert.match(block, /posted under that earlier message, as a thread/)
})

test('an earlier message outside the transcript is named without its words', () => {
  const block = buildOneOnOnePlanBlock(
    { acknowledgeWhenDone: false, earlier: { messageId: EARLIER_ID, reference: 'link' } },
    null,
  )
  assert.ok(block)
  assert.match(block, /goes back to an earlier message in this chat\./)
  assert.match(block, /link to that earlier message beside it/)
})

test('work is told no written reply is owed', () => {
  const block = buildOneOnOnePlanBlock({ acknowledgeWhenDone: true }, null)
  assert.ok(block)
  assert.match(block, /end your turn without text/)
  assert.equal(buildOneOnOnePlanBlock(undefined, null), null)
  assert.equal(buildOneOnOnePlanBlock({ acknowledgeWhenDone: false }, null), null)
})
