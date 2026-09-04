import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectCodexStream,
  mapMessagesToCodex,
  mapToolsToCodex,
  readCodexResponse,
} from '../src/inference/connectors/codex-responses-protocol.js'
import type { ProviderStreamEvent } from '../src/inference/types.js'

/**
 * The Responses API is a different wire format from chat/completions, so this
 * pins the translation: same event vocabulary out, whatever the shape in.
 */

const sse = (events: unknown[]): Response => {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(new TextEncoder().encode(body))
}

const drain = async (
  response: Response,
): Promise<{ events: ProviderStreamEvent[]; result: Awaited<ReturnType<typeof readCodexResponse>> }> => {
  const stream = collectCodexStream(response)
  const events: ProviderStreamEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}

test('text deltas arrive as the same output_text.delta every connector emits', async () => {
  const { events, result } = await drain(sse([
    { delta: 'Hello', type: 'response.output_text.delta' },
    { delta: ' there', type: 'response.output_text.delta' },
    { response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 4 } }, type: 'response.completed' },
  ]))

  assert.deepEqual(
    events.filter((event) => event.type === 'output_text.delta'),
    [
      { text: 'Hello', type: 'output_text.delta' },
      { text: ' there', type: 'output_text.delta' },
    ],
  )
  assert.equal(result.outputText, 'Hello there')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.usage.inputTokens, 10)
  assert.equal(result.usage.outputTokens, 4)
})

test('a tool call fragment always names the call it belongs to', async () => {
  // The Responses API announces name and call_id once, in output_item.added,
  // and every later fragment carries only the item id. A consumer streaming
  // arguments must still know which call each fragment belongs to — this is
  // the same correction the chat/completions connector needed.
  const { events, result } = await drain(sse([
    {
      item: { call_id: 'call_abc', id: 'item_1', name: 'search', type: 'function_call' },
      type: 'response.output_item.added',
    },
    { delta: '{"q":', item_id: 'item_1', type: 'response.function_call_arguments.delta' },
    { delta: '"cats"}', item_id: 'item_1', type: 'response.function_call_arguments.delta' },
    { response: { status: 'completed' }, type: 'response.completed' },
  ]))

  const toolDeltas = events.filter((event) => event.type === 'tool_call.delta')
  assert.equal(toolDeltas.length, 2)
  for (const delta of toolDeltas) {
    assert.equal(delta.type === 'tool_call.delta' && delta.id, 'call_abc')
    assert.equal(delta.type === 'tool_call.delta' && delta.toolName, 'search')
  }
  assert.deepEqual(result.toolCalls, [
    { arguments: { q: 'cats' }, toolCallId: 'call_abc', toolName: 'search' },
  ])
  assert.equal(result.finishReason, 'tool-call')
})

test('a fragment for an unannounced item is dropped rather than invented', async () => {
  const { events, result } = await drain(sse([
    { delta: '{"a":1}', item_id: 'item_unknown', type: 'response.function_call_arguments.delta' },
    { response: { status: 'completed' }, type: 'response.completed' },
  ]))
  assert.equal(events.filter((event) => event.type === 'tool_call.delta').length, 0)
  assert.deepEqual(result.toolCalls, [])
})

test('reasoning deltas map onto the shared reasoning event', async () => {
  const { events } = await drain(sse([
    { delta: 'thinking', type: 'response.reasoning_summary_text.delta' },
    { response: { status: 'completed' }, type: 'response.completed' },
  ]))
  assert.deepEqual(events, [{ text: 'thinking', type: 'reasoning_text.delta' }])
})

test('an incomplete response reports length rather than a clean stop', async () => {
  const { result } = await drain(sse([
    { delta: 'partial', type: 'response.output_text.delta' },
    { response: { status: 'incomplete' }, type: 'response.incomplete' },
  ]))
  assert.equal(result.finishReason, 'length')
})

test('unparseable lines never abort the stream', async () => {
  const body = 'data: {not json\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'
  const { result } = await drain(new Response(new TextEncoder().encode(body)))
  assert.equal(result.outputText, 'ok')
})

test('system turns become instructions and tool results their own item', () => {
  const { input, instructions } = mapMessagesToCodex(
    [
      { content: 'Be brief.', role: 'system' },
      { content: 'Hi', role: 'user' },
      {
        content: null,
        role: 'assistant',
        toolCalls: [{ arguments: { q: 'x' }, toolCallId: 'call_1', toolName: 'search' }],
      },
      { content: 'result', role: 'tool', toolCallId: 'call_1' },
    ],
    { vision: true },
  )
  assert.equal(instructions, 'Be brief.')
  assert.deepEqual(input, [
    { content: [{ text: 'Hi', type: 'input_text' }], role: 'user' },
    { arguments: '{"q":"x"}', call_id: 'call_1', name: 'search', type: 'function_call' },
    { call_id: 'call_1', output: 'result', type: 'function_call_output' },
  ])
})

test('a vision-capable Codex request carries an attached image as an input_image part', () => {
  const { input } = mapMessagesToCodex(
    [{
      content: 'Evaluate this chart.',
      images: [{ dataBase64: 'AAECAw==', mime: 'image/png' }],
      role: 'user',
    }],
    { vision: true },
  )

  assert.deepEqual(input, [{
    content: [
      { text: 'Evaluate this chart.', type: 'input_text' },
      { image_url: 'data:image/png;base64,AAECAw==', type: 'input_image' },
    ],
    role: 'user',
  }])
})

test('a non-vision Codex request omits image bytes', () => {
  const { input } = mapMessagesToCodex(
    [{
      content: 'Evaluate this chart.',
      images: [{ dataBase64: 'AAECAw==', mime: 'image/png' }],
      role: 'user',
    }],
    { vision: false },
  )

  assert.deepEqual(input, [{
    content: [{ text: 'Evaluate this chart.', type: 'input_text' }],
    role: 'user',
  }])
})

test('tools are flat in the Responses shape, not nested under a function key', () => {
  const tools = mapToolsToCodex([
    { description: 'Search', inputSchema: { type: 'object' }, toolName: 'search' },
  ])
  assert.deepEqual(tools, [
    { description: 'Search', name: 'search', parameters: { type: 'object' }, type: 'function' },
  ])
  assert.equal(mapToolsToCodex([]), undefined)
})

test('a non-streaming response reads the same way as a streamed one', () => {
  const result = readCodexResponse({
    output: [
      { content: [{ text: 'done', type: 'output_text' }], type: 'message' },
      { arguments: '{"q":1}', call_id: 'call_9', name: 'search', type: 'function_call' },
    ],
    status: 'completed',
    usage: { input_tokens: 3, output_tokens: 1 },
  })
  assert.equal(result.outputText, 'done')
  assert.equal(result.finishReason, 'tool-call')
  assert.deepEqual(result.toolCalls, [
    { arguments: { q: 1 }, toolCallId: 'call_9', toolName: 'search' },
  ])
})
