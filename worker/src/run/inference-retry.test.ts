import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderInvocationError } from '@nessie/runtime'
import { callInferenceWithRetry } from './inference-retry.js'

test('Ledger credit exhaustion is thrown to failed-run terminalization, not returned as output', async () => {
  const refusal = new ProviderInvocationError(
    'openai-compatible chat request failed with HTTP 402',
    {
      finishReason: 'error',
      invocationId: 'invocation-402',
      latencyMs: 1,
      model: 'ledger-model',
      operationType: 'chat',
      provider: 'openai-compatible',
      requestId: 'request-402',
      usage: {},
    },
    undefined,
    { creditRefusal: 'ledger', providerCode: 'budget_exceeded', statusCode: 402 },
  )

  await assert.rejects(
    callInferenceWithRetry(
      [{ content: 'hello', role: 'user' }],
      async () => {
        throw refusal
      },
      { remaining: 6, total: 6 },
      1_000,
    ),
    (error) => error === refusal,
  )
})
