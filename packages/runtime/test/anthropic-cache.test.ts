import assert from 'node:assert/strict'
import test from 'node:test'

import {
  toAnthropicPayload,
  type AnthropicPayloadMessage,
} from '../src/inference/connectors/kimi-messages.js'
import type { ProviderMessage, ToolSchemaDescriptor } from '../src/inference/types.js'

const ANCHOR = 'You are a helpful agent.'
const MEMORY = 'Relevant memories:\n- the user prefers tea'

const messages: ProviderMessage[] = [
  { role: 'system', content: ANCHOR },
  { role: 'system', content: MEMORY },
  { role: 'user', content: 'hi' },
]

const tools: ToolSchemaDescriptor[] = [
  { toolName: 'web_search', description: 'Search the web', inputSchema: { type: 'object' } },
]

const systemBlocks = (
  system: ReturnType<typeof toAnthropicPayload>['system'],
): Array<{ type: string; text: string; cache_control?: unknown }> => {
  assert.ok(Array.isArray(system), 'expected a content-block array system')
  return system
}

test('without cache, system is a plain string carrying every system part in order', () => {
  const payload = toAnthropicPayload(messages, undefined)
  assert.equal(typeof payload.system, 'string')
  const system = payload.system as string
  assert.ok(system.includes(ANCHOR))
  assert.ok(system.includes(MEMORY))
  assert.ok(system.indexOf(ANCHOR) < system.indexOf(MEMORY))
})

test('with cache, the breakpoint sits on the stable block only', () => {
  const payload = toAnthropicPayload(messages, tools, { cache: true })
  const blocks = systemBlocks(payload.system)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]?.type, 'text')
  assert.ok(blocks[0]?.text.includes('web_search'), 'tool render joins the stable block')
  assert.ok(blocks[0]?.text.includes(ANCHOR))
  assert.deepEqual(blocks[0]?.cache_control, { type: 'ephemeral' })
  assert.ok(blocks[1]?.text.includes(MEMORY))
  assert.equal(blocks[1]?.cache_control, undefined)
})

test('volatile system variance never changes the cached block bytes', () => {
  const a = toAnthropicPayload(messages, tools, { cache: true })
  const b = toAnthropicPayload(
    [
      { role: 'system', content: ANCHOR },
      { role: 'system', content: 'Working notes from an earlier incomplete run.' },
      { role: 'user', content: 'keep going' },
    ],
    tools,
    { cache: true },
  )
  assert.deepEqual(systemBlocks(a.system)[0], systemBlocks(b.system)[0])
})

test('a mid-run instruction follows the assistant instead of turning its answer into a prefill', () => {
  const payload = toAnthropicPayload(
    [
      { role: 'system', content: ANCHOR },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'working on it' },
      { role: 'system', content: 'Budget notice: wind down and hand over.' },
    ],
    undefined,
    { cache: true },
  )
  const blocks = systemBlocks(payload.system)
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0]?.text.includes(ANCHOR))
  assert.deepEqual(blocks[0]?.cache_control, { type: 'ephemeral' })
  assert.deepEqual(payload.messages.map((message) => message.role), ['user', 'assistant', 'user'])
  const tail = payload.messages.at(-1)!
  assert.ok(Array.isArray(tail.content))
  assert.match(tail.content[0]!.text, /<system_instruction>\nBudget notice: wind down and hand over\.\n<\/system_instruction>/)
})

test('with cache, a sliding breakpoint rides on the last message only', () => {
  const payload = toAnthropicPayload(messages, undefined, { cache: true })
  const last = payload.messages.at(-1) as AnthropicPayloadMessage
  assert.ok(Array.isArray(last.content), 'tail message becomes a content-block array')
  const block = last.content[0] as { text: string; cache_control?: unknown }
  assert.equal(block.text, 'hi')
  assert.deepEqual(block.cache_control, { type: 'ephemeral' })
  for (const message of payload.messages.slice(0, -1)) {
    assert.equal(typeof message.content, 'string', 'earlier messages stay plain strings')
  }
})

test('without cache, messages stay plain strings', () => {
  const payload = toAnthropicPayload(messages, undefined)
  for (const message of payload.messages) {
    assert.equal(typeof message.content, 'string')
  }
})

test('cache flag with no system content yields no system', () => {
  const payload = toAnthropicPayload([{ role: 'user', content: 'hi' }], undefined, { cache: true })
  assert.equal(payload.system, undefined)
})

test('empty-answer recovery stays after the request even when the empty assistant turn is omitted', () => {
  const payload = toAnthropicPayload([
    { role: 'system', content: ANCHOR },
    { role: 'user', content: 'Measure once.' },
    { role: 'assistant', content: null },
    { role: 'system', content: 'No answer or tool call arrived. Continue the authorized work.' },
  ])
  assert.equal(payload.system, ANCHOR)
  assert.deepEqual(payload.messages, [{
    role: 'user',
    content: 'Measure once.\n\n<system_instruction>\n'
      + 'No answer or tool call arrived. Continue the authorized work.\n</system_instruction>',
  }])
})
