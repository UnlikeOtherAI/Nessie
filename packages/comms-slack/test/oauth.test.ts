import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ConnectorConnectionContext } from '@nessie/comms-connect'

import { createSlackConnector } from '../src/connector.js'
import type { FetchLike } from '../src/types.js'

type RouteHandler = (init?: RequestInit) => { status?: number; body: unknown }

const routedFetch = (routes: Record<string, RouteHandler>): FetchLike =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/api/')[1] ?? ''
    const handler = routes[method]
    if (!handler) {
      throw new Error(`unexpected slack call: ${method}`)
    }
    const { status = 200, body } = handler(init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as FetchLike

const NOW_MS = 1_721_550_000_000

const baseDeps = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  signingSecret: 'signing-secret',
  redirectUri: 'https://nessie.example/callback',
  now: () => NOW_MS,
  maxRetries: 0,
}

test('connect maps the user-token path and auth.test identity', async () => {
  const connector = createSlackConnector({
    ...baseDeps,
    fetchImpl: routedFetch({
      'oauth.v2.access': () => ({
        body: {
          ok: true,
          team: { id: 'T_TEAM' },
          authed_user: {
            id: 'U_USER',
            scope: 'channels:history,channels:read,groups:history',
            access_token: 'xoxp-user-token',
            refresh_token: 'xoxe-refresh',
            expires_in: 43_200,
          },
        },
      }),
      'auth.test': () => ({
        body: { ok: true, user_id: 'U_USER', team_id: 'T_TEAM' },
      }),
    }),
  })

  const result = await connector.connect({
    organizationId: 'org',
    userId: 'user',
    provider: 'slack',
    code: 'auth-code',
    redirectUri: 'https://nessie.example/callback',
    statePayload: {},
  })

  assert.equal(result.externalTenantId, 'T_TEAM')
  assert.equal(result.externalUserId, 'U_USER')
  assert.equal(result.credential.accessToken, 'xoxp-user-token')
  assert.equal(result.credential.refreshToken, 'xoxe-refresh')
  assert.equal(
    result.credential.expiresAt,
    new Date(NOW_MS + 43_200 * 1000).toISOString(),
  )
  assert.deepEqual(result.grantedScopes, [
    'channels:history',
    'channels:read',
    'groups:history',
  ])
})

const context = (
  overrides: Partial<ConnectorConnectionContext['credential']>,
): ConnectorConnectionContext => ({
  id: 'conn',
  organizationId: 'org',
  ownerUserId: 'user',
  provider: 'slack',
  externalTenantId: 'T_TEAM',
  externalUserId: 'U_USER',
  credential: {
    accessToken: 'xoxp-old',
    scopes: ['channels:history'],
    ...overrides,
  },
})

test('refreshCredentials rotates when a refresh token is present', async () => {
  const connector = createSlackConnector({
    ...baseDeps,
    fetchImpl: routedFetch({
      'oauth.v2.access': () => ({
        body: {
          ok: true,
          access_token: 'xoxp-new',
          refresh_token: 'xoxe-new',
          expires_in: 100,
          scope: 'channels:history,channels:read',
        },
      }),
    }),
  })

  const bundle = await connector.refreshCredentials(
    context({ refreshToken: 'xoxe-old' }),
  )
  assert.equal(bundle.accessToken, 'xoxp-new')
  assert.equal(bundle.refreshToken, 'xoxe-new')
  assert.equal(bundle.expiresAt, new Date(NOW_MS + 100 * 1000).toISOString())
  assert.deepEqual(bundle.scopes, ['channels:history', 'channels:read'])
})

test('refreshCredentials returns the bundle unchanged for a non-rotating token', async () => {
  const connector = createSlackConnector({
    ...baseDeps,
    fetchImpl: routedFetch({
      'oauth.v2.access': () => {
        throw new Error('must not call Slack when there is no refresh token')
      },
    }),
  })

  const original = context({}).credential
  const bundle = await connector.refreshCredentials(context({}))
  assert.deepEqual(bundle, original)
})
