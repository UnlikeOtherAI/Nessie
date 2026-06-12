import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeToolInput } from './tool-util.js'

test('summarizeToolInput redacts secret-bearing fields recursively', () => {
  const summary = summarizeToolInput({
    auth: {
      accessToken: 'tok_live_secret',
      nested: [{ clientSecret: 'client-secret' }],
    },
    query: 'public query',
    webhook: {
      headers: {
        Authorization: 'Bearer should-not-leak',
      },
    },
  })

  assert.equal(summary.includes('tok_live_secret'), false)
  assert.equal(summary.includes('client-secret'), false)
  assert.equal(summary.includes('Bearer should-not-leak'), false)
  assert.ok(summary.includes('public query'))
  assert.ok(summary.includes('[REDACTED]'))
})
