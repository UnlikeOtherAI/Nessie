import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readNativePushRegistration,
  shouldRegisterNativePush,
} from '../src/lib/native-push-registration.js'

const eventWithDetail = (detail: unknown): Event => ({ detail }) as unknown as Event

test('accepts a structurally valid native APNs registration', () => {
  assert.deepEqual(
    readNativePushRegistration(eventWithDetail({
      platform: 'ios',
      token: 'apns-device-token',
      appVersion: '0.1.0',
    })),
    {
      platform: 'ios',
      token: 'apns-device-token',
      appVersion: '0.1.0',
    },
  )
})

test('rejects malformed native bridge payloads', () => {
  assert.equal(readNativePushRegistration(eventWithDetail({ platform: 'ios' })), null)
  assert.equal(readNativePushRegistration(eventWithDetail({ platform: 'web', token: 'x' })), null)
})

test('native push registration is disabled for imported debug sessions', () => {
  assert.equal(shouldRegisterNativePush(true, 'renewable'), true)
  assert.equal(shouldRegisterNativePush(true, 'imported'), false)
  assert.equal(shouldRegisterNativePush(false, 'renewable'), false)
})
