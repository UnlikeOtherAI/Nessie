import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentStatusSchema,
  AgentTriggerStatusSchema,
  ExecutorCodingSessionStatusSchema,
  ExecutorStatusSchema,
} from '@nessie/schemas'
import {
  CONNECTION_STATUS_WORDS,
  agentStatusSentence,
  computerStatusSentence,
  connectionStatusSentence,
  deliveryStatusSentence,
  sessionStatusSentence,
  triggerStatusSentence,
  type ConnectionStatusValue,
  type StatusSentence,
} from '../src/lib/status-sentences.js'

// A raw value on screen is the defect this module exists to remove, so the
// shape of every answer is asserted, not only the words.
const assertReadable = (value: string, answer: StatusSentence): void => {
  assert.notEqual(answer.label, value, `${value} must not be shown as itself`)
  assert.doesNotMatch(answer.label, /_/u, `${value}'s label must not be an enum`)
  assert.doesNotMatch(answer.sentence, /_/u, `${value}'s sentence must not carry an enum`)
  assert.match(answer.sentence, /[.]$/u, `${value}'s sentence must be a sentence`)
}

test('every agent state has words, not its enum', () => {
  for (const status of AgentStatusSchema.options) {
    assertReadable(status, agentStatusSentence(status))
  }
  assert.equal(agentStatusSentence('waiting_approval').label, 'Waiting for approval')
  assert.equal(agentStatusSentence('executing').tone, 'accent')
})

test('a schedule that must be reauthorized says so and says what to do', () => {
  for (const status of AgentTriggerStatusSchema.options) {
    assertReadable(status, triggerStatusSentence(status))
  }
  const repair = triggerStatusSentence('needs_reauthorization')
  assert.equal(repair.label, 'Needs attention')
  assert.match(repair.sentence, /reauthorize it/u)
  assert.equal(triggerStatusSentence('paused').label, 'Turned off')
})

test('every delivery outcome is a word', () => {
  for (const status of ['pending', 'delivered', 'failed', 'skipped', 'skipped_overlap']) {
    assertReadable(status, deliveryStatusSentence(status))
  }
})

test('a computer waiting for its pairing is not finished, with the remedy', () => {
  for (const status of ExecutorStatusSchema.options) {
    assertReadable(status, computerStatusSentence(status))
  }
  const pending = computerStatusSentence('pending_pairing')
  assert.equal(pending.label, 'Not finished')
  assert.match(pending.sentence, /confirm the pairing/u)
})

test('every coding session state is a word', () => {
  for (const status of ExecutorCodingSessionStatusSchema.options) {
    assertReadable(status, sessionStatusSentence(status))
  }
  assert.equal(sessionStatusSentence('waiting_for_input').label, 'Waiting for input')
})

test('anything connected speaks in the five words', () => {
  const values: ConnectionStatusValue[] = [
    'active', 'connected', 'connecting', 'disabled', 'disconnected',
    'error', 'expired', 'needs_reauthorization', 'paused', 'pending_setup',
  ]
  for (const value of values) {
    const answer = connectionStatusSentence(value)
    assertReadable(value, answer)
    assert.ok(
      (CONNECTION_STATUS_WORDS as readonly string[]).includes(answer.label),
      `${value} reads "${answer.label}", outside the five words`,
    )
  }
  assert.equal(connectionStatusSentence('pending_setup').label, 'Not finished')
  assert.equal(connectionStatusSentence('needs_reauthorization').label, 'Needs attention')
  assert.equal(connectionStatusSentence('expired').label, 'Needs attention')
})

test('a value nobody has worded yet never reaches the screen as itself', () => {
  for (const describe of [
    agentStatusSentence,
    triggerStatusSentence,
    deliveryStatusSentence,
    computerStatusSentence,
    sessionStatusSentence,
    connectionStatusSentence,
  ]) {
    const answer = describe('some_future_state')
    assert.equal(answer.label, 'Unknown')
    assertReadable('some_future_state', answer)
  }
  // `hasOwnProperty`, not `in`: an inherited name is not a state either.
  assert.equal(connectionStatusSentence('toString').label, 'Unknown')
})
