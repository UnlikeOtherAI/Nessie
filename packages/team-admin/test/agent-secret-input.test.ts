import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSecretInputError,
  assertAgentSecretFreeInput,
} from '../src/agent-secret-input.js'

test('agent prompt fields refuse structurally detected credentials', () => {
  const secret = `sk-proj-${'aB3_'.repeat(8)}`

  for (const input of [
    { name: `Agent ${secret}` },
    { role: `Use ${secret}` },
    { speakingStyle: `Repeat ${secret}` },
    { systemPrompt: `Authenticate with ${secret}` },
  ]) {
    assert.throws(() => assertAgentSecretFreeInput(input), AgentSecretInputError)
  }
})

test('ordinary agent configuration remains accepted', () => {
  assert.doesNotThrow(() => assertAgentSecretFreeInput({
    name: 'Researcher',
    role: 'Investigate product questions',
    speakingStyle: 'Be direct and concise',
    systemPrompt: 'Cite every supplied source.',
  }))
})
