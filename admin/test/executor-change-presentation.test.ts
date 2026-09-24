import assert from 'node:assert/strict'
import test from 'node:test'

import { executorChangePresentation } from '../src/components/features/executors/executor-change-presentation.js'

/**
 * The review of a trigger's standing machine access, opened from its one
 * confirmation card (docs/standards/agent-cards.md): it names the agent, the
 * trigger and the machines, says what confirming lets a board's editors do,
 * and can be confirmed — where a kind this version does not know never can.
 */

const change = {
  agentId: '11111111-0000-4000-8000-000000000001',
  executors: [],
  kind: 'standing_policy',
  policyId: '11111111-0000-4000-8000-000000000002',
  summary: { machineLabels: ['Minis', 'Studio'], triggerName: 'Pick up tickets' },
  triggerId: '11111111-0000-4000-8000-000000000003',
}

test('standing machine access reads as what it is, and is reviewable once its agent is known', () => {
  const copy = executorChangePresentation(change, 'CTO')
  assert.equal(copy.title, 'Allow standing machine access')
  assert.equal(copy.action, 'Allow machine access')
  assert.equal(copy.reviewable, true)
  assert.match(copy.description, /^CTO will work tickets from “Pick up tickets” on Minis and Studio\./)
  assert.match(copy.description, /make Claude run commands there as you, with your git and coding-agent login/)
})

test('without its agent, or its summary, it cannot be confirmed', () => {
  assert.equal(executorChangePresentation(change).reviewable, false)
  assert.equal(executorChangePresentation({ ...change, summary: undefined }, 'CTO').reviewable, false)
  assert.equal(executorChangePresentation({ kind: 'something_new' }, 'CTO').reviewable, false)
})
