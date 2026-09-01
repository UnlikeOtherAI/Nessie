import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPromptCacheKey } from '../src/inference/prompt-cache.js'
import type { ProviderMessage, ToolSchemaDescriptor } from '../src/inference/types.js'

const anchor: ProviderMessage = { role: 'system', content: 'You are Aria.\n\nBe helpful.' }

const tools: ToolSchemaDescriptor[] = [
  { toolName: 'web_search', description: 'Search', inputSchema: {} },
  { toolName: 'delegate', description: 'Delegate', inputSchema: {} },
]

test('the key hashes the anchor only, so later-message variance never rotates it', () => {
  const a = buildPromptCacheKey('m1', [anchor, { role: 'system', content: 'memory A' }], tools)
  const b = buildPromptCacheKey(
    'm1',
    [anchor, { role: 'system', content: 'memory B' }, { role: 'user', content: 'hi' }],
    tools,
  )
  assert.ok(a)
  assert.equal(a, b)
})

test('the key rotates with the anchor, the model, and the tool set', () => {
  const base = buildPromptCacheKey('m1', [anchor], tools)
  assert.notEqual(
    buildPromptCacheKey('m1', [{ role: 'system', content: 'You are Boron.' }], tools),
    base,
  )
  assert.notEqual(buildPromptCacheKey('m2', [anchor], tools), base)
  assert.notEqual(buildPromptCacheKey('m1', [anchor], tools.slice(0, 1)), base)
})

test('tool order does not rotate the key', () => {
  const reversed = [...tools].reverse()
  assert.equal(
    buildPromptCacheKey('m1', [anchor], tools),
    buildPromptCacheKey('m1', [anchor], reversed),
  )
})

test('no messages yields no key', () => {
  assert.equal(buildPromptCacheKey('m1', [], tools), undefined)
})
