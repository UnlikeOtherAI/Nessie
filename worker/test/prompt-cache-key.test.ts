import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage, ToolSchemaDescriptor } from '@nessie/runtime'
import { buildPromptCacheKey } from '../src/run/inference.js'

const system: ProviderMessage[] = [{ role: 'system', content: 'You are a helpful agent.' }]
const tools: ToolSchemaDescriptor[] = [
  { toolName: 'web_search', description: 'search', inputSchema: {} },
  { toolName: 'send_message', description: 'send', inputSchema: {} },
]

test('same prefix (model + tools + system) yields the same key', () => {
  const a = buildPromptCacheKey('gpt-5-mini', system, tools)
  // Tool order must not matter — the set is what's cached.
  const b = buildPromptCacheKey('gpt-5-mini', system, [...tools].reverse())
  assert.ok(a)
  assert.equal(a, b)
})

test('different model, system, or tools yields a different key', () => {
  const base = buildPromptCacheKey('gpt-5-mini', system, tools)
  assert.notEqual(base, buildPromptCacheKey('gpt-5', system, tools))
  assert.notEqual(
    base,
    buildPromptCacheKey('gpt-5-mini', [{ role: 'system', content: 'Different prompt.' }], tools),
  )
  assert.notEqual(base, buildPromptCacheKey('gpt-5-mini', system, [tools[0]]))
})

test('no anchor message yields no key', () => {
  assert.equal(buildPromptCacheKey('gpt-5-mini', [], tools), undefined)
})
