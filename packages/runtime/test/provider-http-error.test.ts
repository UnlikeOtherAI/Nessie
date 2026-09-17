import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenAiLikeConnector } from '../src/inference/connectors/openai.js'
import { providerHttpError } from '../src/inference/connectors/connector-invocations.js'
import {
  isCreditsExhaustedError,
  ProviderHttpError,
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
        assert.match(error.message, /balance empty/)
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
        assert.match(error.message, /provider account needs payment/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerHttpError prefers a structured message and redacts credential-shaped values', async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        message: 'Invalid model: gpt-5-codex. Authorization: Bearer sk-live1234567890abcdef',
      },
    }),
    { status: 400 },
  )
  const error = await providerHttpError({ operation: 'chat', provider: 'codex-subscription', response })
  assert.ok(error instanceof ProviderHttpError)
  assert.equal(error.statusCode, 400)
  assert.match(error.message, /Invalid model: gpt-5-codex/)
  assert.doesNotMatch(error.message, /sk-live1234567890abcdef/)
  assert.match(error.message, /\[redacted\]/)
})

test('providerHttpError falls back to a redacted raw body snippet', async () => {
  const response = new Response('invalid request: api_key=super-secret-key-12345', { status: 400 })
  const error = await providerHttpError({ operation: 'chat', provider: 'openai', response })
  assert.ok(error instanceof ProviderHttpError)
  assert.match(error.message, /invalid request/)
  assert.doesNotMatch(error.message, /super-secret-key-12345/)
  assert.match(error.message, /\[redacted\]/)
})
