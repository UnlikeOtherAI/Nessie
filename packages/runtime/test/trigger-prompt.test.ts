import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTriggerPrompt } from '../src/scheduling.js'

/**
 * The trigger kickoff text is model-facing only — it is written as a `system`
 * message so it drives the run without appearing in the channel. These guard
 * the two things that bit in production: the sentence used to read
 * "A interval trigger fired…", and the payload has to survive into the prompt
 * (a webhook fire is useless to the agent without its body).
 */

test('the generic kickoff reads correctly for every trigger type', () => {
  for (const triggerType of ['manual', 'scheduled', 'interval', 'webhook', 'event'] as const) {
    const text = buildTriggerPrompt({
      payload: undefined,
      source: 'scheduler',
      triggerType,
    })
    assert.ok(
      text.startsWith(`Trigger fired: ${triggerType} (source: scheduler).`),
      `unexpected prefix for ${triggerType}: ${text}`,
    )
    // "A interval" / "A event" — the article bug this replaced.
    assert.doesNotMatch(text, /\bA (interval|event)\b/)
  }
})

test('the payload reaches the model', () => {
  const text = buildTriggerPrompt({
    payload: { deviceId: 'dev-1', state: 'offline' },
    source: 'webhook',
    triggerType: 'webhook',
  })
  assert.match(text, /"deviceId": "dev-1"/)
  assert.match(text, /"state": "offline"/)
})

test('a missing payload says so rather than printing undefined', () => {
  const text = buildTriggerPrompt({
    payload: undefined,
    source: 'scheduler',
    triggerType: 'scheduled',
  })
  assert.match(text, /No payload was provided\./)
  assert.doesNotMatch(text, /undefined/)
})

test('an operator-authored prompt is used verbatim, not wrapped in trigger chatter', () => {
  const text = buildTriggerPrompt({
    payload: { scheduledFor: '2026-08-11T19:27:00.000Z' },
    prompt: 'Sweep the estate and report anything that needs a person.',
    source: 'scheduler',
    triggerType: 'interval',
  })
  assert.ok(text.startsWith('Sweep the estate and report anything that needs a person.'))
  assert.doesNotMatch(text, /Trigger fired:/)
})
