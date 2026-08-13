import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectChatStream } from '../src/inference/connectors/openai-chat-protocol.js'
import type { ProviderStreamEvent } from '../src/inference/types.js'

/** Build a Response whose body is an OpenAI-shaped SSE stream. */
const streamResponse = (chunks: unknown[]): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body)
}

const drain = async (
  response: Response,
): Promise<{ events: ProviderStreamEvent[]; result: Awaited<ReturnType<typeof collect>> }> => {
  const stream = collectChatStream(response)
  const events: ProviderStreamEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}
type collect = typeof collectChatStream extends (r: Response) => AsyncGenerator<
  ProviderStreamEvent,
  infer TReturn,
  undefined
>
  ? () => TReturn
  : never

test('tool-call deltas carry the accumulated call identity, not just the fragment', async () => {
  const { events } = await drain(
    streamResponse([
      // The canonical first chunk: id and name, empty arguments. It yields no
      // event of its own, so later fragments must still know who they belong to.
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'kb_document_compose', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"markdown":"a' } }] } },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'b"}' } }] } }],
      },
    ]),
  )

  const toolDeltas = events.filter((event) => event.type === 'tool_call.delta')
  assert.equal(toolDeltas.length, 2)
  for (const delta of toolDeltas) {
    assert.equal(delta.type === 'tool_call.delta' && delta.id, 'call_1')
    assert.equal(delta.type === 'tool_call.delta' && delta.toolName, 'kb_document_compose')
    assert.equal(delta.type === 'tool_call.delta' && delta.index, 0)
  }
})

test('a chunk carrying both content and tool fragments feeds both paths', async () => {
  // Regression: the tool loop used to be skipped for any chunk that also had
  // content, which dropped the fragment from the yielded stream *and* from the
  // accumulated arguments — corrupting the call that was about to execute.
  const { events, result } = await drain(
    streamResponse([
      {
        choices: [
          {
            delta: {
              content: 'thinking out loud',
              tool_calls: [
                { index: 0, id: 'call_2', function: { name: 'demo', arguments: '{"a":1}' } },
              ],
            },
          },
        ],
      },
    ]),
  )

  assert.equal(
    events.some((event) => event.type === 'output_text.delta' && event.text === 'thinking out loud'),
    true,
  )
  assert.equal(events.some((event) => event.type === 'tool_call.delta'), true)
  assert.deepEqual(result.toolCalls, [
    { arguments: { a: 1 }, toolCallId: 'call_2', toolName: 'demo' },
  ])
})

test('parallel tool calls keep their fragments separate', async () => {
  const { events, result } = await drain(
    streamResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'alpha', arguments: '{"x":' } },
                { index: 1, id: 'call_b', function: { name: 'beta', arguments: '{"y":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '1}' } },
                { index: 1, function: { arguments: '2}' } },
              ],
            },
          },
        ],
      },
    ]),
  )

  const byIndex = new Map<number, string>()
  for (const event of events) {
    if (event.type !== 'tool_call.delta') continue
    byIndex.set(event.index, (byIndex.get(event.index) ?? '') + event.text)
  }
  assert.equal(byIndex.get(0), '{"x":1}')
  assert.equal(byIndex.get(1), '{"y":2}')
  assert.equal(result.toolCalls.length, 2)
})
