import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_PREVIEW_LENGTH,
  MAX_RAW_BODY_CHARS,
  MAX_TOOL_RESULT_CHARS,
  summarizeToolInput,
  truncate,
  truncateToolResult,
} from './tool-util.js'

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

test('tool summaries and results mask structural credentials under ordinary keys', () => {
  const token = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const summary = summarizeToolInput({ result: token })
  const output = truncateToolResult(`remote result: ${token}`)

  assert.doesNotMatch(summary, /1234567890abcdefghijklmnop/)
  assert.doesNotMatch(output, /1234567890abcdefghijklmnop/)
  assert.match(output, new RegExp(`sk_live_${'•'.repeat(12)}`))
})

test('truncateToolResult leaves within-cap output untouched', () => {
  const output = 'x'.repeat(100)
  assert.equal(truncateToolResult(output, 200), output)
})

test('truncateToolResult keeps output at exactly the cap untouched', () => {
  const output = 'x'.repeat(200)
  assert.equal(truncateToolResult(output, 200), output)
  // One character over is the first truncated case.
  assert.notEqual(truncateToolResult(`${output}x`, 200), `${output}x`)
  assert.match(truncateToolResult(`${output}x`, 200), /truncated 1 chars/)
})

test('truncateToolResult cuts the middle, keeping both head and tail', () => {
  const output = `${'H'.repeat(120)}${'M'.repeat(50)}${'T'.repeat(80)}`
  const result = truncateToolResult(output, 200)

  // 70% head / 30% tail of the budget: 140 head chars, 60 tail chars.
  assert.ok(result.startsWith('H'.repeat(120)))
  assert.ok(result.endsWith('T'.repeat(60)))
  assert.match(result, /\n\n\[\.\.\. truncated 50 chars \.\.\.\]\n\n/)

  // The kept content is exactly the cap; the marker is additive.
  const [head, tail] = result.split(/\n\n\[\.\.\. truncated \d+ chars \.\.\.\]\n\n/)
  assert.equal((head ?? '').length + (tail ?? '').length, 200)
  // Everything dropped came from the middle.
  assert.equal(result.includes('M'.repeat(50)), false)
})

test('truncateToolResult is idempotent — no double truncation marker', () => {
  const output = 'y'.repeat(250)
  const once = truncateToolResult(output, 200)
  const twice = truncateToolResult(once, 200)

  assert.equal(twice, once)
  assert.equal(twice.match(/\[\.\.\. truncated/g)?.length, 1)
})

test('a per-tool truncation survives the 32k chokepoint unchanged', () => {
  // Builtins pre-truncate at their own cap; the loop re-applies the chokepoint
  // to every result. The already-truncated string must pass through as-is.
  const capped = truncateToolResult('z'.repeat(50_000), MAX_RAW_BODY_CHARS)
  assert.equal(truncateToolResult(capped, MAX_TOOL_RESULT_CHARS), capped)
  // And re-applying an even smaller cap still detects the marker.
  assert.equal(truncateToolResult(capped, 500), capped)
})

test('tool result caps keep discovery tools within one order of magnitude', () => {
  // web_search / web_fetch / document_read truncate through `truncate`'s
  // default; http_fetch caps its raw body; the loop chokepoint is the ceiling.
  assert.equal(MAX_PREVIEW_LENGTH, 4_000)
  assert.equal(MAX_RAW_BODY_CHARS, 12_000)
  assert.equal(MAX_TOOL_RESULT_CHARS, 32_000)
  assert.ok(MAX_RAW_BODY_CHARS / MAX_PREVIEW_LENGTH <= 4)
})

test('truncate defaults to the content-tool cap', () => {
  const capped = truncate('a'.repeat(10_000))
  assert.equal(capped.length, MAX_PREVIEW_LENGTH)
  assert.ok(capped.endsWith('…'))
  assert.equal(truncate('a'.repeat(4_000)).length, 4_000)
})
