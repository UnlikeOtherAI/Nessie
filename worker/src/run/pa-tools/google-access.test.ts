import assert from 'node:assert/strict'
import test from 'node:test'

import { explainGoogleFailure } from './google-access.js'

test('unknown Google failures never repeat provider details to the model', async () => {
  const providerDetail = 'smtp://mail.internal.example token=secret user=owner@example.test'

  await assert.rejects(
    explainGoogleFailure({} as never, 'gmail.compose', 'user-1', new Error(providerDetail)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(providerDetail), false)
      assert.equal(error.message.includes('owner@example.test'), false)
      assert.match(error.message, /GOOGLE_REQUEST_FAILED/)
      return true
    },
  )
})
