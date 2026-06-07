import assert from 'node:assert/strict'
import test from 'node:test'
import type { PushResult } from '@nessie/push'
import {
  PUSH_MAX_SEND_ATTEMPTS,
  isTransientPushFailure,
  shouldRetryPushFailure,
} from '../src/control/push-retry.js'

const failed = (
  status: number,
  error?: string,
  deadToken = false,
): PushResult => ({
  ok: false,
  status,
  error,
  deadToken,
})

test('classifies APNs transient failures as provider 5xx only', () => {
  assert.equal(isTransientPushFailure('apns', failed(500)), true)
  assert.equal(isTransientPushFailure('apns', failed(503)), true)
  assert.equal(isTransientPushFailure('apns', failed(0, 'network down')), false)
  assert.equal(isTransientPushFailure('apns', failed(400, 'BadDeviceToken')), false)
  assert.equal(isTransientPushFailure('apns', failed(500, 'Unregistered', true)), false)
})

test('classifies FCM transient failures by 5xx, network status, or UNAVAILABLE', () => {
  assert.equal(isTransientPushFailure('fcm', failed(500)), true)
  assert.equal(isTransientPushFailure('fcm', failed(503)), true)
  assert.equal(isTransientPushFailure('fcm', failed(0, 'network down')), true)
  assert.equal(isTransientPushFailure('fcm', failed(400, 'UNAVAILABLE')), true)
  assert.equal(isTransientPushFailure('fcm', failed(400, 'INVALID_ARGUMENT')), false)
  assert.equal(isTransientPushFailure('fcm', failed(503, 'UNREGISTERED', true)), false)
})

test('does not retry once the max attempt has been reached', () => {
  const transient = failed(503, 'UNAVAILABLE')
  assert.equal(shouldRetryPushFailure('fcm', transient, 1), true)
  assert.equal(
    shouldRetryPushFailure('fcm', transient, PUSH_MAX_SEND_ATTEMPTS),
    false,
  )
})
