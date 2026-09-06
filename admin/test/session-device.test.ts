import assert from 'node:assert/strict'
import test from 'node:test'

import { describeSessionDevice } from '../src/lib/session-device.ts'

test('session device labels identify native shells before interpreting their WebKit agent', () => {
  assert.deepEqual(
    describeSessionDevice({
      clientType: 'native-ios',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15',
    }),
    { name: 'Nessie iOS app', detail: 'Native app on iPhone or iPad' },
  )
})

test('session device labels distinguish Safari, Chrome, and mobile browsers', () => {
  assert.deepEqual(
    describeSessionDevice({
      clientType: null,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    }),
    { name: 'Safari on Mac', detail: 'Browser session' },
  )
  assert.deepEqual(
    describeSessionDevice({
      clientType: null,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36',
    }),
    { name: 'Chrome on Android phone', detail: 'Mobile browser session' },
  )
})
