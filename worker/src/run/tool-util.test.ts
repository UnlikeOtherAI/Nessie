import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeToolInput, truncateToolResult } from './tool-util.js'

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

test('truncateToolResult leaves within-cap output untouched', () => {
  const output = 'x'.repeat(100)
  assert.equal(truncateToolResult(output, 200), output)
})

test('truncateToolResult caps oversized output with a dropped-char marker', () => {
  const output = 'x'.repeat(250)
  const result = truncateToolResult(output, 200)

  assert.ok(result.startsWith('x'.repeat(200)))
  assert.match(result, /\n\n\[truncated 50 chars\]$/)
  // The kept prefix is exactly the cap; the marker is additive.
  assert.equal(result.slice(0, 200), 'x'.repeat(200))
})

test('truncateToolResult is idempotent — no double truncation marker', () => {
  const output = 'y'.repeat(250)
  const once = truncateToolResult(output, 200)
  const twice = truncateToolResult(once, 200)

  assert.equal(twice, once)
  assert.equal(twice.match(/\[truncated/g)?.length, 1)
})
