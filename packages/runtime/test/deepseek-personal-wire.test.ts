import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAiLikeConnector } from '../src/inference/connectors/openai.js'
import type {
  ProviderInvocationResult,
  ProviderStreamEvent,
} from '../src/inference/types.js'

const sse = (chunks: unknown[]): Response => {
  const body = [...chunks, '[DONE]']
    .map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
    .join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

const drain = async (
  stream: AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined>,
): Promise<ProviderInvocationResult> => {
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}

test('a personal DeepSeek tool round trip is pinned and uses nonthinking wire fields', async () => {
  const responses = [
    sse([{
      choices: [{
        delta: {
          tool_calls: [{
            function: { arguments: '{"city":"London"}', name: 'weather' },
            id: 'call_weather',
            index: 0,
            type: 'function',
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }]),
    sse([{
      choices: [{ delta: { content: 'It is sunny.' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 },
    }]),
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
  ]
  const requests: Array<{ body: Record<string, unknown>; headers: Headers; redirect?: string; url: string }> = []
  const connector = createOpenAiLikeConnector(
    'deepseek',
    {
      apiKey: 'personal-deepseek-key',
      baseUrl: 'https://api.deepseek.com/v1',
      deepseekThinkingMode: 'disabled',
      provider: 'deepseek',
    },
    {
      personalDeepSeekSafeFetchOptions: {
        fetchImpl: async (url, init) => {
          requests.push({
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
            headers: new Headers(init.headers),
            redirect: init.redirect,
            url: url.toString(),
          })
          const response = responses.shift()
          assert.ok(response, 'a mocked response exists for every request')
          return response
        },
        resolveHost: async (hostname) => {
          assert.equal(hostname, 'api.deepseek.com')
          return ['1.1.1.1']
        },
      },
    },
  )

  const first = await drain(connector.stream({
    maxOutputTokens: 321,
    messages: [{ content: 'What is the weather?', role: 'user' }],
    model: 'deepseek-flash',
    requestId: 'deepseek-first',
    tools: [{
      description: 'Look up weather.',
      inputSchema: { type: 'object' },
      toolName: 'weather',
    }],
  }))
  assert.deepEqual(first.toolCalls, [{
    arguments: { city: 'London' },
    toolCallId: 'call_weather',
    toolName: 'weather',
  }])

  const second = await drain(connector.stream({
    maxOutputTokens: 321,
    messages: [
      { content: 'What is the weather?', role: 'user' },
      { content: first.outputText, role: 'assistant', toolCalls: first.toolCalls },
      { content: '{"forecast":"sunny"}', role: 'tool', toolCallId: 'call_weather' },
    ],
    model: 'deepseek-flash',
    requestId: 'deepseek-second',
  }))
  assert.equal(second.outputText, 'It is sunny.')

  await connector.fetchCompletion({
    max_completion_tokens: 99,
    model: 'deepseek-flash',
    thinking: { type: 'enabled' },
  })

  assert.equal(requests.length, 3)
  for (const request of requests) {
    assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions')
    assert.equal(request.redirect, 'manual')
    assert.equal(request.headers.get('authorization'), 'Bearer personal-deepseek-key')
    assert.deepEqual(request.body.thinking, { type: 'disabled' })
    assert.equal(request.body.max_tokens, request === requests[2] ? 99 : 321)
    assert.equal(request.body.max_completion_tokens, undefined)
  }
  const replay = requests[1]?.body.messages as Array<Record<string, unknown>>
  assert.equal(replay[1]?.role, 'assistant')
  assert.equal(replay[1]?.content, '')
  assert.equal(replay[2]?.role, 'tool')
  assert.equal(replay[2]?.tool_call_id, 'call_weather')
})
