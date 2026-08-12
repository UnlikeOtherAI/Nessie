import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorError,
  nextExecutorLifecycleStatus,
} from '../src/index.js'

test('lifecycle never presumes a resumed machine is online', () => {
  assert.equal(nextExecutorLifecycleStatus('paused', 'resume'), 'offline')
  assert.equal(nextExecutorLifecycleStatus('offline', 'pause'), 'paused')
  assert.equal(nextExecutorLifecycleStatus('online', 'drain'), 'draining')
  assert.equal(nextExecutorLifecycleStatus('offline', 'revoke'), 'revoked')
})

test('pending, draining, and revoked executors reject ordinary lifecycle changes', () => {
  for (const status of ['pending_pairing', 'draining', 'revoked'] as const) {
    assert.throws(
      () => nextExecutorLifecycleStatus(status, 'pause'),
      (error: unknown) => error instanceof ExecutorError && error.code === 'EXECUTOR_STATE_TRANSITION_INVALID',
    )
  }
})
