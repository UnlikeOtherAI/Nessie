import assert from 'node:assert/strict'
import test from 'node:test'

import { requiresFreshExecutorVerification } from '../src/index.js'

test('private assignment changes, grants, and revocation require a fresh human verification', () => {
  assert.equal(requiresFreshExecutorVerification({
    kind: 'private_assignment',
    action: 'set',
    assignment: { principalKind: 'user', userId: 'user-1', role: 'admin' },
  }), true)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_operation_grant',
    agentId: 'agent-1',
    operationKey: 'command.run',
    state: 'allowed',
  }), true)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'lifecycle',
    action: 'revoke',
  }), true)
})

test('low-risk denial and pause changes still require structural user confirmation', () => {
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_operation_grant',
    agentId: 'agent-1',
    operationKey: 'command.run',
    state: 'denied',
  }), false)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'lifecycle',
    action: 'pause',
  }), false)
})
