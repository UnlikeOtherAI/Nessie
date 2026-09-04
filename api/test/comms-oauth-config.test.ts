import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CommsConnectionStartRequestSchema } from '@nessie/schemas'

import {
  buildAuthorizeUrl,
  getCommsOAuthConfig,
} from '../src/routes/comms/oauth-config.js'
import { callbackErrorCode } from '../src/routes/comms/oauth-routes.js'

test('Microsoft start uses PKCE, nonce and least-privilege Graph mail scopes', () => {
  const config = getCommsOAuthConfig('microsoft')
  assert.ok(config)
  assert.equal(config.usePkce, true)
  assert.equal(config.useNonce, true)
  assert.ok(config.scopes.includes('Mail.Read'))
  assert.ok(config.scopes.includes('User.Read'))
  assert.ok(!config.scopes.includes('Mail.Send'))
  assert.ok(!config.scopes.includes('Mail.ReadWrite'))

  const url = new URL(buildAuthorizeUrl({
    config,
    clientId: 'client-id',
    redirectUri: 'https://api.example.test/api/comms/connections/microsoft/callback',
    state: 'server-state',
    codeChallenge: 'challenge',
    nonce: 'nonce',
    loginHint: 'me@example.com',
  }))
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.example.test/api/comms/connections/microsoft/callback')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('nonce'), 'nonce')
  assert.equal(url.searchParams.get('login_hint'), 'me@example.com')
})

test('loginHint is bounded, structural email input only', () => {
  assert.equal(
    CommsConnectionStartRequestSchema.parse({ loginHint: 'Name@Example.COM' }).loginHint,
    'Name@Example.COM',
  )
  assert.equal(CommsConnectionStartRequestSchema.safeParse({ loginHint: 'not-an-email' }).success, false)
})

test('callback exposes only structural provider error states', () => {
  assert.equal(callbackErrorCode({ authorizationBlocked: true }), 'provider_access_blocked')
  assert.equal(callbackErrorCode({ needsReauthorization: true }), 'reauthorization_required')
  assert.equal(callbackErrorCode({ message: 'arbitrary provider body' }), 'connect_failed')
})
