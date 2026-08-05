import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePersonalAssistantDecisions } from './orchestrate.js'

const personalAssistant = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Personal Assistant',
  role: 'assistant',
  systemPrompt: null,
}

test('a personal-assistant DM always creates a threaded reply decision for a human turn', () => {
  assert.deepEqual(
    resolvePersonalAssistantDecisions('personal_assistant', 'user', [personalAssistant]),
    // Structural, like the @mention fast path: the turn is addressed to this
    // one assistant, so its answer belongs to that exchange.
    [{ action: 'reply', agentId: personalAssistant.id, replyPlacement: 'thread' }],
  )
})

test('a personal-assistant DM does not reply to an assistant-authored turn', () => {
  assert.deepEqual(
    resolvePersonalAssistantDecisions('personal_assistant', 'assistant', [personalAssistant]),
    [],
  )
})

test('shared channels remain on the model-judged engagement path', () => {
  assert.equal(
    resolvePersonalAssistantDecisions(null, 'user', [personalAssistant]),
    null,
  )
})
