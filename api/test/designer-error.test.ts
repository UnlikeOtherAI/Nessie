import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderHttpError } from '@nessie/runtime'
import { userMessageForDesignerError } from '../src/services/designer.js'

test('designer SSE replaces a Ledger credit refusal with the shared billing guidance', () => {
  const refusal = new ProviderHttpError(
    'openai-compatible chat request failed with HTTP 402',
    { creditRefusal: 'ledger', providerCode: 'budget_exceeded', statusCode: 402 },
  )

  assert.equal(
    userMessageForDesignerError(refusal),
    'Your team has no AI credits remaining. Ask a billing manager to add credits or update billing in Credits & billing (/tokens), then try again.',
  )
})
