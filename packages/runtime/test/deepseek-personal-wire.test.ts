import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAiLikeConnector } from '../src/inference/connectors/openai.js'
import { createKimiConnector } from '../src/inference/connectors/kimi.js'
import { createInferenceService } from '../src/inference/service.js'
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

test('a personal DeepSeek tool round trip is pinned, thinks on the live turn and replays its reasoning', async () => {
  const responses = [
    sse([{
      choices: [{ delta: { reasoning_content: 'Need the forecast first.' } }],
    }, {
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
      provider: 'deepseek',
    },
    {
      pinnedFetchOptions: {
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
  assert.equal(first.reasoningText, 'Need the forecast first.')

  const second = await drain(connector.stream({
    maxOutputTokens: 321,
    messages: [
      { content: 'What is the weather?', role: 'user' },
      {
        content: first.outputText,
        reasoning: first.reasoningText,
        role: 'assistant',
        toolCalls: first.toolCalls,
      },
      { content: '{"forecast":"sunny"}', role: 'tool', toolCallId: 'call_weather' },
    ],
    model: 'deepseek-flash',
    requestId: 'deepseek-second',
  }))
  assert.equal(second.outputText, 'It is sunny.')

  // A silent raw call: thinking is the dialect's decision, not the caller's.
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
    assert.equal(request.body.max_tokens, request === requests[2] ? 99 : 321)
    assert.equal(request.body.max_completion_tokens, undefined)
  }
  assert.deepEqual(requests[0]?.body.thinking, { type: 'enabled' })
  assert.deepEqual(requests[1]?.body.thinking, { type: 'enabled' })
  assert.deepEqual(requests[2]?.body.thinking, { type: 'disabled' })
  // DeepSeek answers 400 on a tool round that does not carry every assistant
  // turn's reasoning_content back, so the replay is what keeps the loop alive.
  const replay = requests[1]?.body.messages as Array<Record<string, unknown>>
  assert.equal(replay[1]?.role, 'assistant')
  assert.equal(replay[1]?.content, '')
  assert.equal(replay[1]?.reasoning_content, 'Need the forecast first.')
  assert.equal(replay[2]?.role, 'tool')
  assert.equal(replay[2]?.tool_call_id, 'call_weather')
})

test('an unbounded conversational request omits completion caps while an explicit utility cap remains', async () => {
  const requests: Array<Record<string, unknown>> = []
  const connector = createOpenAiLikeConnector('deepseek', {
    apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1', provider: 'deepseek',
  }, {
    pinnedFetchOptions: {
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
      },
      resolveHost: async () => ['1.1.1.1'],
    },
  })
  await connector.invoke({ messages: [{ content: 'hello', role: 'user' }], model: 'test', requestId: 'main' })
  await connector.invoke({ maxOutputTokens: 77, messages: [{ content: 'note', role: 'user' }], model: 'test', requestId: 'utility' })
  assert.equal(requests[0]?.max_completion_tokens, undefined)
  assert.equal(requests[0]?.max_tokens, undefined)
  assert.equal(requests[1]?.max_tokens, 77)
})

test('Kimi derives its required Messages max_tokens from provider model metadata', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    const url = input.toString()
    requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) })
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding', context_length: 1_048_576 }] }))
    return new Response(JSON.stringify({ content: [{ text: 'ok', type: 'text' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
  }
  try {
    const connector = createKimiConnector({ apiKey: 'key', baseUrl: 'https://api.kimi.com/coding', provider: 'kimi' })
    const capability = await connector.getModelCapabilities('kimi-for-coding')
    assert.equal(capability.maxOutputTokens, 1_048_576)
    await connector.invoke({ maxOutputTokens: capability.maxOutputTokens, messages: [{ content: 'hi', role: 'user' }], model: 'kimi-for-coding', requestId: 'kimi' })
    assert.equal(requests[1]?.body?.max_tokens, 1_048_576)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a transient Kimi metadata lookup is not cached and later resolves its provider limit', async () => {
  const originalFetch = globalThis.fetch
  let modelLookups = 0
  globalThis.fetch = async (input) => {
    const url = input.toString()
    if (url.endsWith('/v1/models')) {
      modelLookups += 1
      if (modelLookups === 1) throw new Error('ECONNRESET')
      return new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding', context_length: 1_048_576 }] }))
    }
    throw new Error(`unexpected request: ${url}`)
  }
  try {
    const service = createInferenceService({
      apiKey: 'key', baseUrl: 'https://api.kimi.com/coding', provider: 'kimi',
    })
    await assert.rejects(service.getCapabilities('kimi-for-coding'), /temporarily unavailable/)
    const capability = await service.getCapabilities('kimi-for-coding')
    assert.equal(capability.effectiveSnapshot.maxOutputTokens, 1_048_576)
    assert.equal(modelLookups, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})


test('Kimi rejects malformed and missing model metadata without caching the failure', async () => {
  const originalFetch = globalThis.fetch
  const payloads = [
    'null',
    JSON.stringify({ data: {} }),
    JSON.stringify({ data: [] }),
  ]
  globalThis.fetch = async (input) => {
    assert.match(input.toString(), /\/v1\/models$/)
    const payload = payloads.shift()
    if (payload === undefined) throw new Error('unexpected metadata lookup')
    return new Response(payload)
  }
  try {
    const service = createInferenceService({
      apiKey: 'key', baseUrl: 'https://api.kimi.com/coding', provider: 'kimi',
    })
    await assert.rejects(service.getCapabilities('kimi-for-coding'), /metadata response is malformed/)
    await assert.rejects(service.getCapabilities('kimi-for-coding'), /metadata response is malformed/)
    await assert.rejects(service.getCapabilities('kimi-for-coding'), /configured model was not found/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
