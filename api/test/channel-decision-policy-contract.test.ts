import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CHANNEL_DECISION_POLICY } from '@nessie/schemas'
import { UpdateChannelBodySchema } from '../src/contracts/team.js'

test('the channel PATCH contract accepts policy-only replacement and clearing', () => {
  assert.deepEqual(UpdateChannelBodySchema.parse({ decisionPolicy: DEFAULT_CHANNEL_DECISION_POLICY }), {
    decisionPolicy: DEFAULT_CHANNEL_DECISION_POLICY,
  })
  assert.deepEqual(UpdateChannelBodySchema.parse({ decisionPolicy: null }), { decisionPolicy: null })
  assert.equal(UpdateChannelBodySchema.safeParse({}).success, false)
})

test('the channel PATCH contract rejects a malformed enum before writing', () => {
  assert.equal(UpdateChannelBodySchema.safeParse({ decisionPolicy: {
    ...DEFAULT_CHANNEL_DECISION_POLICY,
    questions: [{ id: 'tracking', instructions: 'Track?', options: [{ id: 'yes', description: 'Track it' }] }],
  } }).success, false)
})
