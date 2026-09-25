import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAnthropicStream,
  nativeToolCallsFromContent,
} from '../src/inference/connectors/kimi-anthropic-protocol.js'
import type { ProviderStreamEvent } from '../src/inference/types.js'

const sse = (events: unknown[]): Response =>
  new Response(events.map((event) => `data:${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

test('a native tool_use content block on the stream retains its arguments and reasoning', async () => {
  const stream = collectAnthropicStream(sse([
    { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look it up.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"London"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]))
  const events: ProviderStreamEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  assert.deepEqual(next.value.toolCalls, [{ arguments: { city: 'London' }, toolCallId: 'toolu_1', toolName: 'weather' }])
  assert.equal(next.value.reasoningText, 'Look it up.')
  assert.equal(next.value.finishReason, 'tool-call')
  assert.equal(events.some((event) => event.type === 'reasoning_text.delta'), true)
})

test('native blocks in a non-streaming body are read the same way', () => {
  assert.deepEqual(
    nativeToolCallsFromContent([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'toolu_2', name: 'weather', input: { city: 'Oslo' } },
    ]),
    [{ arguments: { city: 'Oslo' }, toolCallId: 'toolu_2', toolName: 'weather' }],
  )
})

test('the last event of a stream that ends without a blank line is not lost', async () => {
  const body = [
    'data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<tool_use>{\\"name\\":\\"weather\\",\\"arguments\\":{}}"}}\n\n',
    // The closing tag arrives in the final event, and the stream closes right
    // after it with no terminating blank line.
    'data:{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"</tool_use>"}}',
  ].join('')
  const stream = collectAnthropicStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  assert.equal(next.value.outputText, '<tool_use>{"name":"weather","arguments":{}}</tool_use>')
})
