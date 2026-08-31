import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAiLikeConnector } from '../src/inference/connectors/openai.js'
import {
  isCreditsExhaustedError,
  ProviderInvocationError,
} from '../src/inference/types.js'

test('an OpenAI-compatible Ledger 402 budget_exceeded response survives as typed invocation data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { code: 'budget_exceeded', message: 'balance empty' } }),
    { status: 402 },
  )) as typeof fetch

  try {
    const connector = createOpenAiLikeConnector('openai-compatible', {
      apiKey: 'ledger-key',
      baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
      provider: 'openai-compatible',
    })
    await assert.rejects(
      connector.invoke({
        messages: [{ content: 'hello', role: 'user' }],
        model: 'ledger-model',
        requestId: 'request-402',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderInvocationError)
        assert.equal(error.statusCode, 402)
        assert.equal(error.providerCode, 'budget_exceeded')
        assert.equal(error.creditRefusal, 'ledger')
        assert.equal(isCreditsExhaustedError(error), true)
        assert.doesNotMatch(error.message, /balance empty/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a direct provider 402 is typed but is not labeled as team-credit exhaustion', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { message: 'provider account needs payment' } }),
    { status: 402 },
  )) as typeof fetch

  try {
    const connector = createOpenAiLikeConnector('openai', {
      apiKey: 'provider-key',
      baseUrl: 'https://api.openai.com/v1',
      provider: 'openai',
    })
    await assert.rejects(
      connector.invoke({
        messages: [{ content: 'hello', role: 'user' }],
        model: 'provider-model',
        requestId: 'request-provider-402',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderInvocationError)
        assert.equal(error.statusCode, 402)
        assert.equal(error.creditRefusal, undefined)
        assert.equal(isCreditsExhaustedError(error), false)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
