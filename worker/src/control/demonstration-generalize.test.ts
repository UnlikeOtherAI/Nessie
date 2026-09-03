import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDemonstrationDraft } from './demonstration-generalize.js'

const demonstration = {
  agent: { model: null, provider: null },
  agentId: '10000000-0000-4000-8000-000000000001',
  channelId: '10000000-0000-4000-8000-000000000002',
  id: '10000000-0000-4000-8000-000000000003',
  organizationId: '10000000-0000-4000-8000-000000000004',
  startedByUserId: '10000000-0000-4000-8000-000000000005',
  steps: [{ argumentsJson: { url: 'https://example.test' }, success: true, toolName: 'web_fetch' }],
  threadId: '10000000-0000-4000-8000-000000000006',
}

test('the scripted generalizer folds non-workflow operations into an executable agent task', () => {
  const draft = normalizeDemonstrationDraft(demonstration, {
    name: 'Weekly status routine',
    steps: [
      {
        instruction: 'Review the demonstrated executor operation and report the result.',
        title: 'Review team',
        type: 'executor.browser.open',
      },
    ],
    variableSchema: {
      target: { type: 'string' },
    },
  })

  assert.equal(draft.graph.steps[0]?.type, 'agent_task')
  assert.equal(draft.graph.steps[0]?.input?.agentId, demonstration.agentId)
  assert.equal(draft.graph.steps[0]?.input?.prompt, 'Review the demonstrated executor operation and report the result.')
})

test('the closed vocabulary refuses unknown deterministic tools before persistence', () => {
  const draft = normalizeDemonstrationDraft(demonstration, {
    name: 'Safe routine',
    steps: [{ instruction: 'Perform the connector operation with judgment.', toolName: 'not_a_tool', type: 'tool' }],
  })

  assert.equal(draft.graph.steps[0]?.type, 'agent_task')
  assert.equal(draft.graph.steps[0]?.input?.agentId, demonstration.agentId)
})
