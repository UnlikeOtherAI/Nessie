import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyError,
  resolveRecovery,
  userMessageForFailureReason,
} from './error-classification.js'

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
