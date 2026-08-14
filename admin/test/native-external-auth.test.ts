import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_EXTERNAL_AUTH_EVENT,
  settleNativeExternalAuthResult,
  subscribeToNativeExternalAuthResults,
} from '../src/lib/native-external-auth.js'

const settle = (value: unknown): {
  errors: Array<string | null>
  pendingClears: number
  result: ReturnType<typeof settleNativeExternalAuthResult>
  submitting: boolean[]
} => {
  let pendingClears = 0
  const errors: Array<string | null> = []
  const submitting: boolean[] = []
  const result = settleNativeExternalAuthResult(value, {
    clearPendingAuth: () => {
      pendingClears += 1
    },
    setError: (message) => errors.push(message),
    setSubmitting: (value) => submitting.push(value),
  })
  return { errors, pendingClears, result, submitting }
}

test('native auth cancellation clears PKCE state and releases the login button silently', () => {
  assert.deepEqual(settle({ type: 'cancelled' }), {
    errors: [null],
    pendingClears: 1,
    result: 'settled',
    submitting: [false],
  })
})

test('native auth failure clears PKCE state, releases the button, and shows its message', () => {
  assert.deepEqual(settle({ message: 'Could not open sign-in.', type: 'failed' }), {
    errors: ['Could not open sign-in.'],
    pendingClears: 1,
    result: 'settled',
    submitting: [false],
  })
})

test('success remains busy for the authorization-code exchange', () => {
  assert.deepEqual(settle({ type: 'success', url: 'nessie://auth/callback?code=one' }), {
    errors: [],
    pendingClears: 0,
    result: 'success',
    submitting: [],
  })
})

test('cancellation tolerates unrelated detail fields', () => {
  assert.deepEqual(settle({ type: 'cancelled', message: 42 }), {
    errors: [null],
    pendingClears: 1,
    result: 'settled',
    submitting: [false],
  })
})

test('unrecognized page events cannot disturb login state', () => {
  assert.deepEqual(settle({ type: 'unknown' }), {
    errors: [],
    pendingClears: 0,
    result: 'ignored',
    submitting: [],
  })
})

test('the native event subscription releases the busy state and can be removed', () => {
  const target = new EventTarget()
  let pendingClears = 0
  let submitting = true
  const errors: Array<string | null> = []
  const unsubscribe = subscribeToNativeExternalAuthResults(target, {
    clearPendingAuth: () => {
      pendingClears += 1
    },
    setError: (message) => errors.push(message),
    setSubmitting: (value) => {
      submitting = value
    },
  })

  target.dispatchEvent(new CustomEvent(NATIVE_EXTERNAL_AUTH_EVENT, {
    detail: { type: 'cancelled' },
  }))
  assert.equal(submitting, false)
  assert.equal(pendingClears, 1)
  assert.deepEqual(errors, [null])

  submitting = true
  unsubscribe()
  target.dispatchEvent(new CustomEvent(NATIVE_EXTERNAL_AUTH_EVENT, {
    detail: { type: 'cancelled' },
  }))
  assert.equal(submitting, true)
  assert.equal(pendingClears, 1)
})
