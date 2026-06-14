import assert from 'node:assert/strict'
import test from 'node:test'

import { toAnthropicPayload } from '../src/inference/connectors/kimi-anthropic-protocol.js'
import type { ProviderMessage } from '../src/inference/types.js'

const messages: ProviderMessage[] = [
  { role: 'system', content: 'You are a helpful agent.' },
  { role: 'user', content: 'hi' },
]

test('without cache, system is a plain string', () => {
  const payload = toAnthropicPayload(messages, undefined)
  assert.equal(typeof payload.system, 'string')
})

test('with cache, system becomes a content-block array with an ephemeral cache_control breakpoint', () => {
  const payload = toAnthropicPayload(messages, undefined, { cache: true })
  assert.ok(Array.isArray(payload.system))
  const block = (payload.system as Array<{ type: string; text: string; cache_control?: unknown }>)[0]
  assert.equal(block.type, 'text')
  assert.ok(block.text.includes('You are a helpful agent.'))
  assert.deepEqual(block.cache_control, { type: 'ephemeral' })
})

test('cache flag with no system content yields no system', () => {
  const payload = toAnthropicPayload([{ role: 'user', content: 'hi' }], undefined, { cache: true })
  assert.equal(payload.system, undefined)
})
