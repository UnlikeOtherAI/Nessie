import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyError,
  resolveRecovery,
  userMessageForFailureReason,
} from './error-classification.js'
import { ProviderInvocationError } from '@nessie/runtime'

test('missing model credentials tell the user how to resolve the problem', () => {
  const error = new Error('Missing API key for provider kimi')

  assert.equal(classifyError(error), 'credentials_missing')
  assert.equal(
    userMessageForFailureReason(classifyError(error)),
    'No API key is configured for the model provider. Ask a workspace owner to add the provider credential, then try again.',
  )
  assert.deepEqual(
    resolveRecovery(classifyError(error), 0, { remaining: 6, total: 6 }),
    {
      action: 'surface_error',
      userMessage:
        'No API key is configured for the model provider. Ask a workspace owner to add the provider credential, then try again.',
    },
  )
})

test('rejected model credentials give a safe, actionable error', () => {
  const error = new Error('Provider responded with status 401: invalid API key')

  assert.equal(classifyError(error), 'auth_permanent')
  assert.equal(
    userMessageForFailureReason(classifyError(error)),
    'The model provider rejected its API key. Ask a workspace owner to update the provider credential, then try again.',
  )
})

test('an unsafe provider scope tells the user which configuration must change', () => {
  const error = new Error(
    'openai model error 403: {"error":{"message":"Product app key has an unsafe wildcard scope for kimi"}}',
  )

  assert.equal(classifyError(error), 'credentials_scope')
  assert.deepEqual(
    resolveRecovery(classifyError(error), 0, { remaining: 6, total: 6 }),
    {
      action: 'surface_error',
      userMessage:
        'The workspace AI service credential is not permitted to use the configured model. Ask a workspace owner to update its allowed model scope, then try again.',
    },
  )
})

test('a typed Ledger 402 is exhausted credits, never a generic billing error', () => {
  const error = new ProviderInvocationError(
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

  assert.equal(classifyError(error), 'credits_exhausted')
  assert.equal(
    userMessageForFailureReason(classifyError(error)),
    'Your team has no AI credits remaining. Ask a billing manager to add credits or update billing in Credits & billing (/tokens), then try again.',
  )
  assert.deepEqual(
    resolveRecovery(classifyError(error), 0, { remaining: 0, total: 6 }),
    { action: 'fail_run' },
  )
})

test('a direct provider 402 remains a provider billing error', () => {
  const error = new ProviderInvocationError(
    'openai chat request failed with HTTP 402',
    {
      finishReason: 'error',
      invocationId: 'invocation-provider-402',
      latencyMs: 1,
      model: 'provider-model',
      operationType: 'chat',
      provider: 'openai',
      requestId: 'request-provider-402',
      usage: {},
    },
    undefined,
    { statusCode: 402 },
  )

  assert.equal(classifyError(error), 'billing')
})
