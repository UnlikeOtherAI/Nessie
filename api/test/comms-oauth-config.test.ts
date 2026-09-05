import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CommsConnectionStartRequestSchema } from '@nessie/schemas'

import {
  clearConnectors,
  registerConnector,
  type ConnectorFactory,
} from '@nessie/comms-connect'

import {
  buildAuthorizeUrl,
  getCommsOAuthConfig,
  isCommsProviderConnectable,
} from '../src/routes/comms/oauth-config.js'
import {
  callbackErrorCode,
  callbackQueryErrorCode,
} from '../src/routes/comms/oauth-routes.js'

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
  assert.equal(callbackQueryErrorCode('admin_consent_required'), 'provider_access_blocked')
  assert.equal(callbackQueryErrorCode('consent_required'), 'provider_access_blocked')
  assert.equal(callbackQueryErrorCode('access_denied'), 'access_denied')
  assert.equal(callbackQueryErrorCode('arbitrary_provider_error'), 'access_denied')
})

test('a provider is connectable only when both its adapter and its client id exist', (t) => {
  const clientId = process.env.NESSIE_COMMS_GOOGLE_CLIENT_ID
  t.after(() => {
    clearConnectors()
    if (clientId === undefined) delete process.env.NESSIE_COMMS_GOOGLE_CLIENT_ID
    else process.env.NESSIE_COMMS_GOOGLE_CLIENT_ID = clientId
  })

  // Registration is the whole signal; `hasConnector` never runs the factory.
  const factory: ConnectorFactory = () => {
    throw new Error('the availability check must not build a connector')
  }

  clearConnectors()
  process.env.NESSIE_COMMS_GOOGLE_CLIENT_ID = 'client-id'
  // A client id alone builds an authorize URL but has nothing to exchange the
  // returned code with, so the person would only fail on the way back.
  assert.equal(isCommsProviderConnectable('google'), false)

  registerConnector('google', factory)
  assert.equal(isCommsProviderConnectable('google'), true)

  delete process.env.NESSIE_COMMS_GOOGLE_CLIENT_ID
  assert.equal(isCommsProviderConnectable('google'), false)

  // Slack has start configuration but no client id in this process; Apple has
  // no start configuration at all and is not a comms provider.
  assert.equal(isCommsProviderConnectable('slack'), false)
})
