import assert from 'node:assert/strict'
import test from 'node:test'

import { SourceCredentialRejectedError } from '@nessie/board-sources'

import { createLinearAdapter } from '../src/adapter.js'

test('a deployment with no OAuth app still offers the key, and not the sign-in', () => {
  const adapter = createLinearAdapter({})
  assert.equal(adapter.auth.oauth, undefined)
  assert.ok(adapter.auth.apiKey)
})

test('both halves of an OAuth app are needed before the sign-in is offered', () => {
  assert.equal(createLinearAdapter({ clientId: 'id' }).auth.oauth, undefined)
  assert.equal(createLinearAdapter({ clientSecret: 'secret' }).auth.oauth, undefined)
  assert.ok(createLinearAdapter({ clientId: 'id', clientSecret: 'secret' }).auth.oauth)
})

test('the form names the field and where to make one', () => {
  const form = createLinearAdapter({}).auth.apiKey?.form
  assert.equal(form?.fields.length, 1)
  assert.equal(form?.fields[0]?.key, 'apiKey')
  // Write-only: a secret field is never echoed back by any route.
  assert.equal(form?.fields[0]?.kind, 'secret')
  assert.equal(form?.createUrl, 'https://linear.app/settings/account/security')
})

test('an empty or blank key is refused before anything is dialled', async () => {
  const apiKey = createLinearAdapter({}).auth.apiKey
  assert.ok(apiKey)
  for (const values of [{}, { apiKey: '' }, { apiKey: '   ' }]) {
    await assert.rejects(
      apiKey.verify(values),
      (error: unknown) =>
        error instanceof SourceCredentialRejectedError && error.code === 'LINEAR_KEY_MISSING',
      `expected ${JSON.stringify(values)} to be refused without a request`,
    )
  }
})
