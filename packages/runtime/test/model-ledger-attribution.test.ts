import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelClient } from '../src/model.js'

const MODEL_RESPONSE = {
  choices: [
    {
      finish_reason: 'stop',
      message: { content: 'ok' },
    },
  ],
  model: 'gpt-5-mini',
  usage: {
    completion_tokens: 1,
    prompt_tokens: 2,
    total_tokens: 3,
  },
}

test('routed model client rejects calls that omit usage attribution', async () => {
  let fetchCalled = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalled = true
    return new Response(JSON.stringify(MODEL_RESPONSE))
  }) as typeof fetch
  try {
    const client = createModelClient(
      {
        apiKey: 'proxy-token',
        baseUrl: 'https://example.test/v1',
        provider: 'openai',
      },
      {
        requestHeaders: async () => ({ 'X-Nessie-Context': 'signed' }),
        systemComponent: 'test-model-service',
      },
    )
    await assert.rejects(
      client.chat([{ content: 'hello', role: 'user' }]),
      /require explicit usage attribution/,
    )
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('routed model client completes and records the same five-field attribution', async () => {
  const headersAttribution: unknown[] = []
  const ledgerAttribution: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(MODEL_RESPONSE))) as typeof fetch
  try {
    const client = createModelClient(
      {
        apiKey: 'proxy-token',
        baseUrl: 'https://example.test/v1',
        provider: 'openai',
      },
      {
        recordUsage: async (_invocations, attribution) => {
          ledgerAttribution.push(attribution)
        },
        requestHeaders: async (attribution) => {
          headersAttribution.push(attribution)
          return { 'X-Nessie-Context': 'signed' }
        },
        systemComponent: 'knowledge-summary',
      },
    )
    const usage = {
      actorId: '00000000-0000-4000-8000-000000000001',
      actorType: 'user' as const,
      organizationId: '00000000-0000-4000-8000-000000000002',
      requestId: 'request-1',
      teamId: '00000000-0000-4000-8000-000000000003',
      userId: '00000000-0000-4000-8000-000000000001',
    }
    assert.equal(
      await client.chat(
        [{ content: 'hello', role: 'user' }],
        { usage },
      ),
      'ok',
    )
    assert.equal(headersAttribution.length, 1)
    assert.equal(ledgerAttribution.length, 1)
    assert.deepEqual(headersAttribution[0], ledgerAttribution[0])
    const completed = headersAttribution[0] as {
      agentId: string
      runId: string
      systemComponent: string
    }
    assert.match(completed.agentId, /^[0-9a-f-]{36}$/)
    assert.match(completed.runId, /^[0-9a-f-]{36}$/)
    assert.equal(completed.systemComponent, 'knowledge-summary')
  } finally {
    globalThis.fetch = originalFetch
  }
})
