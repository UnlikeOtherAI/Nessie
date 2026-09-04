import assert from 'node:assert/strict'
import test from 'node:test'

import { createRequestRateLimitChecker } from '../src/lib/rate-limit.js'

const request = {
  ip: '203.0.113.9',
  method: 'POST',
  routeOptions: { url: '/api/mailbox-connections/discover' },
  url: '/api/mailbox-connections/discover',
}

test('mailbox discovery is capped at thirty requests per minute per resolved IP', () => {
  const check = createRequestRateLimitChecker()
  for (let index = 0; index < 30; index += 1) {
    assert.equal(check(request as never), null)
  }
  const limited = check(request as never)
  assert.notEqual(limited, null)
  assert.equal((limited?.retryAfterSeconds ?? 0) > 0, true)
})
