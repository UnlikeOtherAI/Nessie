import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_PREVIEW_LENGTH,
  MAX_RAW_BODY_CHARS,
  MAX_TOOL_RESULT_CHARS,
  sanitizeProviderToolCalls,
  summarizeToolInput,
  truncate,
  truncateToolResult,
} from './tool-util.js'

test('provider tool calls replace secret arguments and carry a block marker', () => {
  const token = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const [sanitized] = sanitizeProviderToolCalls([{
    arguments: { nested: { apiKey: token }, ordinary: 'visible' },
    toolCallId: 'call-1',
    toolName: 'external_publish',
  }])

  assert.equal(sanitized?.secretArgumentBlocked, true)
  assert.equal(sanitized?.arguments.ordinary, 'visible')
  assert.doesNotMatch(JSON.stringify(sanitized?.arguments), /1234567890/)
})

test('provider tool calls block opaque values under common token keys', () => {
  const tooDeep = { value: 'ordinary' } as Record<string, unknown>
  let cursor = tooDeep
  for (let index = 0; index < 10; index += 1) {
    cursor['next'] = {}
    cursor = cursor['next'] as Record<string, unknown>
  }
  const [sanitized] = sanitizeProviderToolCalls([{
    arguments: {
      accessToken: 'opaque-access-value',
      apitoken: 'short',
      nested: { session_token: 'opaque-session-value' },
      password: [{ value: 'nested-short-value' }],
      tooDeep,
      token: 'opaque-token-value',
      tokenCount: '12345678',
    },
    toolCallId: 'call-opaque',
    toolName: 'external_publish',
  }])

  assert.equal(sanitized?.secretArgumentBlocked, true)
  assert.equal(sanitized?.arguments.tokenCount, '12345678')
  assert.doesNotMatch(JSON.stringify(sanitized?.arguments), /opaque-/)
  assert.doesNotMatch(JSON.stringify(sanitized?.arguments), /nested-short-value/)
  assert.doesNotMatch(JSON.stringify(sanitized?.arguments), /short/)
  assert.match(JSON.stringify(sanitized?.arguments), /\[MaxDepth\]/)
})

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
  assert.match(output, /\[REDACTED_SECRET\]/u)
})

test('tool result redaction precedes cuts and already-truncated early returns', () => {
  const token = ['sk', 'proj', 'abcdefghijklmnopqrstuv'].join('-')
  const acrossCut = truncateToolResult(`${'x'.repeat(135)}${token}${'y'.repeat(100)}`, 200)
  const withMarker = truncateToolResult(
    `${token}\n\n[... truncated 20 chars ...]\n\nend`,
    20,
  )

  assert.doesNotMatch(acrossCut, /abcdefghijklmnopqrstuv/)
  assert.match(acrossCut, /truncated/)
  assert.doesNotMatch(withMarker, /abcdefghijklmnopqrstuv/)
  assert.match(withMarker, /\[REDACTED_SECRET\]/u)
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
