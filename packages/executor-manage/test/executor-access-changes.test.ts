import assert from 'node:assert/strict'
import test from 'node:test'

import { requiresFreshExecutorVerification } from '../src/index.js'

test('private assignment changes, grants and descriptor activation require fresh human verification', () => {
  assert.equal(requiresFreshExecutorVerification({
    kind: 'private_assignment',
    action: 'set',
    assignment: { principalKind: 'user', userId: 'user-1', role: 'admin' },
  }), true)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_operation_grant',
    agentId: 'agent-1',
    operationKey: 'file.read',
    state: 'allowed',
  }), true)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'descriptor_review',
    revision: 2,
    status: 'active',
  }), true)
})

// A sign-in with no fresh factor (every SSO account today) must still be able
// to cut a machine off: both changes only take access away.
test('disconnecting or deleting an executor needs no fresh verification', () => {
  assert.equal(requiresFreshExecutorVerification({ kind: 'lifecycle', action: 'revoke' }), false)
  assert.equal(requiresFreshExecutorVerification({ kind: 'lifecycle', action: 'remove' }), false)
})

test('low-risk denial and pause changes still require structural user confirmation', () => {
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_operation_grant',
    agentId: 'agent-1',
    operationKey: 'file.read',
    state: 'denied',
  }), false)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'lifecycle',
    action: 'pause',
  }), false)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'descriptor_review',
    revision: 2,
    status: 'disabled',
  }), false)
})

test('combined agent access retains fresh verification for a grant', () => {
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_executor_access', agentId: 'agent-1', state: 'allowed',
  }), true)
  // Private removal adds the roster's verification requirement at prepare time.
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_executor_access', agentId: 'agent-1', state: 'denied',
  }), false)
})
