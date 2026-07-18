import assert from 'node:assert/strict'
import test from 'node:test'

import { createInferenceService } from '../src/inference/service.js'
import type { ModelProviderConfig } from '../src/inference/types.js'

type FetchCapture = {
  body: Record<string, unknown>
  headers: Headers
  url: string
}

const withFetchCapture = async (
  config: ModelProviderConfig,
): Promise<{ headers: Headers; url: string }> => {
  const originalFetch = globalThis.fetch
  let captured: { headers: Headers; url: string } | null = null
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    captured = {
      headers: new Headers(init?.headers),
      url: input.toString(),
    }
    return new Response('{}')
  }) as typeof fetch
  try {
    const service = createInferenceService(config)
    await service.fetchCompletion({ messages: [] }, {
      'X-Nessie-Context': 'signed-context',
    })
    service.close()
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(captured)
  return captured
}

const withStreamCapture = async (
  config: ModelProviderConfig,
  responseBody: string,
): Promise<{ captured: FetchCapture; outputText: string }> => {
  const originalFetch = globalThis.fetch
  let captured: FetchCapture | null = null
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    captured = {
      body: JSON.parse(init?.body?.toString() ?? '{}') as Record<string, unknown>,
      headers: new Headers(init?.headers),
      url: input.toString(),
    }
    return new Response(responseBody, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const service = createInferenceService(config)
    assert.ok(service.stream)
    const stream = service.stream({
      messages: [{ content: 'Hello', role: 'user' }],
      requestHeaders: { 'X-Nessie-Context': 'signed-context' },
      requestId: 'request-1',
    })
    let next = await stream.next()
    let outputText = ''
    while (!next.done) {
      if (next.value.type === 'output_text.delta') {
        outputText += next.value.text
      }
      next = await stream.next()
    }
    assert.equal(next.value.outputText, outputText)
    service.close()
    assert.ok(captured)
    return { captured, outputText }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('routes every compiled/custom connector through its Ledger service id', async () => {
  const cases: Array<{
    config: ModelProviderConfig
    expectedUrl: string
  }> = [
    {
      config: {
        apiKey: 'ledger-proxy',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
        provider: 'openai',
      },
      expectedUrl:
        'https://ledger.unlikeotherai.com/v1/openai/chat/completions',
    },
    {
      config: {
        apiKey: 'ledger-proxy',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
        provider: 'kimi',
      },
      expectedUrl:
        'https://ledger.unlikeotherai.com/v1/kimi/messages',
    },
    {
      config: {
        apiKey: 'ledger-proxy',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
        provider: 'minimax',
      },
      expectedUrl:
        'https://ledger.unlikeotherai.com/v1/minimax/chat/completions',
    },
    {
      config: {
        apiKey: 'ledger-proxy',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
        provider: 'openai-compatible',
        serviceId: 'custom-acme',
      },
      expectedUrl:
        'https://ledger.unlikeotherai.com/v1/custom-acme/chat/completions',
    },
  ]

  for (const entry of cases) {
    const captured = await withFetchCapture(entry.config)
    assert.equal(captured.url, entry.expectedUrl)
    assert.equal(captured.headers.get('authorization'), 'Bearer ledger-proxy')
    assert.equal(captured.headers.get('x-nessie-context'), 'signed-context')
  }
})

test('Kimi uses proxy bearer auth only on Ledger and preserves direct auth', async () => {
  const ledger = await withFetchCapture({
    apiKey: 'ledger-proxy',
    baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
    provider: 'kimi',
  })
  assert.equal(ledger.headers.get('authorization'), 'Bearer ledger-proxy')
  assert.equal(ledger.headers.has('x-api-key'), false)

  const direct = await withFetchCapture({
    apiKey: 'kimi-direct',
    baseUrl: 'https://api.kimi.com/coding',
    provider: 'kimi',
  })
  assert.equal(direct.headers.get('x-api-key'), 'kimi-direct')
  assert.equal(direct.headers.has('authorization'), false)
  assert.equal(direct.url, 'https://api.kimi.com/coding/v1/messages')
})

test('Kimi streams through the Ledger Anthropic adapter path and headers', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
  ].join('')
  const { captured, outputText } = await withStreamCapture({
    apiKey: 'ledger-proxy',
    baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
    provider: 'kimi',
  }, sse)

  assert.equal(captured.url, 'https://ledger.unlikeotherai.com/v1/kimi/messages')
  assert.equal(captured.headers.get('authorization'), 'Bearer ledger-proxy')
  assert.equal(captured.headers.get('x-nessie-context'), 'signed-context')
  assert.equal(captured.headers.has('x-api-key'), false)
  assert.equal(captured.body.stream, true)
  assert.equal(outputText, 'hi')
})

test('MiniMax streams through Ledger OpenAI chat while preserving its direct path', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const { captured, outputText } = await withStreamCapture({
    apiKey: 'ledger-proxy',
    baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
    provider: 'minimax',
  }, sse)

  assert.equal(
    captured.url,
    'https://ledger.unlikeotherai.com/v1/minimax/chat/completions',
  )
  assert.equal(captured.headers.get('authorization'), 'Bearer ledger-proxy')
  assert.equal(captured.headers.get('x-nessie-context'), 'signed-context')
  assert.equal(captured.body.stream, true)
  assert.equal(outputText, 'hi')

  const direct = await withFetchCapture({
    apiKey: 'minimax-direct',
    baseUrl: 'https://api.minimax.io/v1',
    provider: 'minimax',
  })
  assert.equal(
    direct.url,
    'https://api.minimax.io/v1/text/chatcompletion_v2',
  )
  assert.equal(direct.headers.get('authorization'), 'Bearer minimax-direct')
})
