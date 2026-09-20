import assert from 'node:assert/strict'
import test from 'node:test'

import { controlLocalInferenceAttempt } from '../src/services/local-inference-attempt-control.js'

const now = new Date('2026-09-20T12:00:00.000Z')

test('revoked daemon authorization fences control before reading an attempt', async () => {
  let read = false
  const state = await controlLocalInferenceAttempt({
    attemptId: 'attempt', dispatchFence: 1, hostId: 'host', now,
    stillAuthorized: async () => false,
    tx: { localInferenceAttempt: { findFirst: async () => { read = true } } } as never,
  })
  assert.equal(state, 'fenced')
  assert.equal(read, false)
})

test('control accepts and renews a leased attempt', async () => {
  let update: unknown
  const state = await controlLocalInferenceAttempt({
    attemptId: 'attempt', dispatchFence: 3, hostId: 'host', now,
    stillAuthorized: async () => true,
    tx: {
      localInferenceAttempt: {
        findFirst: async () => ({ deadlineAt: new Date('2026-09-20T12:01:00.000Z'), dispatchFence: 3, state: 'leased' }),
        updateMany: async (input: unknown) => { update = input },
      },
    } as never,
  })
  assert.equal(state, 'active')
  assert.deepEqual(update, {
    where: { id: 'attempt', dispatchFence: 3, state: { in: ['leased', 'accepted'] } },
    data: { acceptedAt: now, leaseExpiresAt: new Date('2026-09-20T12:01:00.000Z'), state: 'accepted' },
  })
})
