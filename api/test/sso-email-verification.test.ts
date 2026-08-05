import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import type { AuthProviderConfig } from '@nessie/schemas'

import { exchangeExternalAuthCode } from '../src/services/external-auth.js'

const provider = {
  providerId: 'acme-oidc',
  type: 'oidc',
  clientId: 'client-123',
  clientSecret: 'secret',
  issuerUrl: 'https://idp.example.com',
  scopes: [],
} as unknown as AuthProviderConfig

const DISCOVERY = {
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** Serve discovery, token and userinfo from one stub keyed on the URL. */
const stubIdp = (userInfo: Record<string, unknown>): void => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/.well-known/')) return json(DISCOVERY)
    if (url.endsWith('/token')) return json({ access_token: 'at-1' })
    if (url.endsWith('/userinfo')) return json(userInfo)
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

const exchange = () =>
  exchangeExternalAuthCode(provider, {
    code: 'code-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'https://app.example.com/callback',
  })

test('an IdP-asserted unverified email is refused', async () => {
  // Accounts are matched by email, so honouring an address the IdP itself says
  // is unverified would let anyone who can assert it take over that account.
  stubIdp({ email: 'victim@example.com', email_verified: false, name: 'Mallory' })
  await assert.rejects(exchange(), /unverified email/i)
})

test('a verified email is accepted', async () => {
  stubIdp({ email: 'user@example.com', email_verified: true, name: 'Real User' })
  const result = await exchange()
  assert.equal(result.identity.email, 'user@example.com')
})

test('a provider that omits email_verified is still trusted', async () => {
  // Plenty of conformant providers never emit the claim; only an explicit
  // `false` is a rejection signal.
  stubIdp({ email: 'user@example.com', name: 'Real User' })
  const result = await exchange()
  assert.equal(result.identity.email, 'user@example.com')
})
