import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAnthropicStream,
  nativeToolCallsFromContent,
  parseKimiToolCalls,
} from '../src/inference/connectors/kimi-anthropic-protocol.js'
import type { ProviderStreamEvent } from '../src/inference/types.js'

/**
 * Kimi speaks a text tool protocol, and Kimi K2.7 frequently ends a turn right
 * after a block's JSON, before the closing tag. Production delivered a raw
 * `<tool_use>{"name":"task_set_processors","arguments":{}}` to a person on
 * 2026-09-22 because the parser demanded the tag. These tests pin that a
 * block is read by its balanced JSON and that protocol text never reaches the
 * delivered answer.
 */

test('a block cut off before its closing tag is still a tool call, and nothing leaks', () => {
  const { outputText, toolCalls } = parseKimiToolCalls(
    '<tool_use>{"name":"task_set_processors","arguments":{}}',
    'req',
  )
  assert.deepEqual(toolCalls, [{ arguments: {}, toolCallId: 'kimi_req_0', toolName: 'task_set_processors' }])
  assert.equal(outputText, '')
})

test('a closed block is parsed and stripped exactly as before', () => {
  const { outputText, toolCalls } = parseKimiToolCalls(
    'Let me look.\n<tool_use>{"name":"weather","arguments":{"city":"London"}}</tool_use>\nOne moment.',
    'req',
  )
  assert.deepEqual(toolCalls, [{ arguments: { city: 'London' }, toolCallId: 'kimi_req_0', toolName: 'weather' }])
  assert.equal(outputText, 'Let me look.\n\nOne moment.')
})

test('braces inside argument strings do not end the block early', () => {
  const { toolCalls } = parseKimiToolCalls(
    '<tool_use>{"name":"note","arguments":{"text":"a } brace and a \\" quote"}}',
    'req',
  )
  assert.equal(toolCalls[0]?.toolName, 'note')
  assert.equal(toolCalls[0]?.arguments.text, 'a } brace and a " quote')
})

test('several blocks, terminated or not, all dispatch in order', () => {
  const { outputText, toolCalls } = parseKimiToolCalls(
    '<tool_use>{"name":"a","arguments":{}}</tool_use>\n<tool_use>{"name":"b","arguments":{"n":1}}',
    'req',
  )
  assert.deepEqual(toolCalls.map((call) => call.toolName), ['a', 'b'])
  assert.deepEqual(toolCalls.map((call) => call.toolCallId), ['kimi_req_0', 'kimi_req_1'])
  assert.equal(outputText, '')
})

test('a block cut off mid-JSON is dropped and never shown to a person', () => {
  const { outputText, toolCalls } = parseKimiToolCalls(
    'Checking now.\n<tool_use>{"name":"task_set_processors","arguments":{"offs',
    'req',
  )
  assert.deepEqual(toolCalls, [])
  assert.equal(outputText, 'Checking now.')
})

test('a malformed block is dropped without leaking, and the prose around it survives', () => {
  const { outputText, toolCalls } = parseKimiToolCalls(
    'Before.\n<tool_use>{"arguments":{}}</tool_use>\nAfter.',
    'req',
  )
  assert.deepEqual(toolCalls, [])
  assert.equal(outputText, 'Before.\n\nAfter.')
})

test('plain prose is untouched', () => {
  const { outputText, toolCalls } = parseKimiToolCalls('Just an answer.', 'req')
  assert.deepEqual(toolCalls, [])
  assert.equal(outputText, 'Just an answer.')
})

const sse = (events: unknown[]): Response =>
  new Response(events.map((event) => `data:${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

test('a native tool_use content block on the stream is honoured beside the text protocol', async () => {
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
