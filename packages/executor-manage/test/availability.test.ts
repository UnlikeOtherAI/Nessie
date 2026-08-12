import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canManagePrivateAssignments,
  resolveExecutorAvailability,
  type ExecutorAvailabilityInput,
} from '../src/index.js'

const readyPrivate = (): ExecutorAvailabilityInput => ({
  descriptorApproved: true,
  executorStatus: 'online',
  localPolicyAllows: true,
  logicalToolAllowed: true,
  operationGrantState: 'allowed',
  scope: { agentAssigned: true, humanAssignment: 'use', kind: 'private' },
})

test('private availability requires both the named user and named agent', () => {
  assert.deepEqual(resolveExecutorAvailability(readyPrivate()), {
    available: true,
    reason: 'ready',
  })
  assert.deepEqual(
    resolveExecutorAvailability({
      ...readyPrivate(),
      scope: { agentAssigned: false, humanAssignment: 'use', kind: 'private' },
    }),
    { available: false, reason: 'scope_mismatch' },
  )
  assert.deepEqual(
    resolveExecutorAvailability({
      ...readyPrivate(),
      scope: { agentAssigned: true, humanAssignment: 'none', kind: 'private' },
    }),
    { available: false, reason: 'executor_not_discoverable' },
  )
})

test('project availability requires both entitlement and exact run project', () => {
  const input = {
    ...readyPrivate(),
    scope: {
      humanProjectEntitled: true,
      kind: 'project' as const,
      runProjectMatches: true,
    },
  }
  assert.equal(resolveExecutorAvailability(input).available, true)
  assert.deepEqual(
    resolveExecutorAvailability({
      ...input,
      scope: { ...input.scope, runProjectMatches: false },
    }),
    { available: false, reason: 'scope_mismatch' },
  )
})

test('availability fails closed before local execution for every missing gate', () => {
  assert.deepEqual(
    resolveExecutorAvailability({ ...readyPrivate(), executorStatus: 'paused' }),
    { available: false, reason: 'executor_offline' },
  )
  assert.deepEqual(
    resolveExecutorAvailability({ ...readyPrivate(), descriptorApproved: false }),
    { available: false, reason: 'descriptor_unreviewed' },
  )
  assert.deepEqual(
    resolveExecutorAvailability({ ...readyPrivate(), operationGrantState: 'denied' }),
    { available: false, reason: 'operation_ungranted' },
  )
  assert.deepEqual(
    resolveExecutorAvailability({ ...readyPrivate(), logicalToolAllowed: false }),
    { available: false, reason: 'logical_tool_ungranted' },
  )
  assert.deepEqual(
    resolveExecutorAvailability({ ...readyPrivate(), localPolicyAllows: false }),
    { available: false, reason: 'local_policy_denied' },
  )
})

test('only a human private admin may manage private assignments', () => {
  assert.equal(canManagePrivateAssignments('admin'), true)
  assert.equal(canManagePrivateAssignments('use'), false)
  assert.equal(canManagePrivateAssignments('none'), false)
})
