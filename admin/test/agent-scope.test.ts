import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import {
  getAgentScope,
  isAgentScopeEditable,
} from '../src/components/features/agents/agent-scope.js'

const agent = (overrides: Partial<AgentRecord>): AgentRecord =>
  ({
    agentKind: 'shared',
    systemManaged: false,
    ...overrides,
  }) as AgentRecord

test('an ordinary shared agent is a Team agent', () => {
  assert.equal(getAgentScope(agent({})), 'team')
})

test('the Personal Assistant is a Personal agent', () => {
  assert.equal(getAgentScope(agent({ agentKind: 'personal_assistant' })), 'personal')
})

test('a system-managed agent is a Global agent', () => {
  assert.equal(getAgentScope(agent({ systemManaged: true })), 'global')
})

test('the PA wins over the system flag — a system-managed PA is still Personal', () => {
  assert.equal(
    getAgentScope(agent({ agentKind: 'personal_assistant', systemManaged: true })),
    'personal',
  )
})

test('only the Global scope is read-only', () => {
  assert.equal(isAgentScopeEditable('personal'), true)
  assert.equal(isAgentScopeEditable('team'), true)
  assert.equal(isAgentScopeEditable('global'), false)
})
