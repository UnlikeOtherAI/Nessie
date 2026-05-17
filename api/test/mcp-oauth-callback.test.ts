import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import type { PrismaClient } from '@prisma/client'

import { registerMcpOAuthRoutes } from '../src/routes/mcp/oauth.js'
import type { SecretStore } from '../src/services/mcp-oauth.js'

/**
 * Task #39 — pin the OAuth callback's handling of the upstream `error` param.
 *
 * Providers are free to send any string in `?error=` (and `?error_description=`),
 * and a browser following the redirect will land on our endpoint with whatever
 * the attacker-controlled provider URL contained. Echoing the raw value into
 * the response body — or worse, into a redirect URL — enables reflected XSS
 * and open-redirect amplification.
 *
 * The hardened route:
 *   • collapses the `error` param to the RFC 6749 §4.1.2.1 enumeration; any
 *     value outside that set becomes `invalid_request`,
 *   • NEVER echoes `error_description` to the client (only logs it server-side).
 */

const makeApp = () => {
  const app = Fastify({ logger: false })
  const oauthSecretStore: SecretStore = { put: async () => 'secret_stub' }
  registerMcpOAuthRoutes(app, {
    prisma: {} as unknown as PrismaClient,
    requireActorContext: () => null,
    requireOwner: () => false,
    oauthSecretStore,
  })
  return app
}

test('OAuth callback collapses HTML/script payload in `error` to invalid_request', async () => {
  const app = makeApp()
  // Classic reflected-XSS payload smuggled via ?error=…
  const malicious = '<htmltag>"><script>alert(1)</script>'
  const response = await app.inject({
    method: 'GET',
    url: `/api/mcp/oauth/callback?error=${encodeURIComponent(malicious)}`
      + `&error_description=${encodeURIComponent('<img src=x onerror=alert(2)>')}`,
  })
  assert.equal(response.statusCode, 400)
  const body = JSON.parse(response.body) as {
    error?: { code?: string; message?: string }
  }
  assert.equal(body.error?.code, 'MCP_OAUTH_PROVIDER_ERROR')
  // The malicious payload must NOT appear anywhere in the response body —
  // not the raw value, not the description, not URL-encoded.
  assert.equal(
    response.body.includes('<script>'),
    false,
    `raw payload echoed: ${response.body}`,
  )
  assert.equal(
    response.body.includes('onerror'),
    false,
    `error_description echoed: ${response.body}`,
  )
  assert.equal(
    response.body.includes(malicious),
    false,
    `raw error echoed: ${response.body}`,
  )
  // The sanitized fallback IS expected to appear in the message body.
  assert.ok(
    body.error?.message?.includes('invalid_request'),
    `expected sanitized invalid_request, got: ${body.error?.message}`,
  )
  await app.close()
})

test('OAuth callback echoes a whitelisted RFC 6749 error code verbatim', async () => {
  const app = makeApp()
  const response = await app.inject({
    method: 'GET',
    url: '/api/mcp/oauth/callback?error=access_denied',
  })
  assert.equal(response.statusCode, 400)
  const body = JSON.parse(response.body) as {
    error?: { code?: string; message?: string }
  }
  assert.equal(body.error?.code, 'MCP_OAUTH_PROVIDER_ERROR')
  // `access_denied` is a member of the RFC 6749 §4.1.2.1 enumeration so it
  // is safe to surface to the client (the message must reflect it back
  // unchanged for debuggability).
  assert.ok(
    body.error?.message?.includes('access_denied'),
    `expected access_denied passed through, got: ${body.error?.message}`,
  )
  await app.close()
})

test('OAuth callback never reflects upstream error_description to the client', async () => {
  const app = makeApp()
  const secret = 'totally-private-server-state-leaked-via-description'
  const response = await app.inject({
    method: 'GET',
    url: `/api/mcp/oauth/callback?error=server_error`
      + `&error_description=${encodeURIComponent(secret)}`,
  })
  assert.equal(response.statusCode, 400)
  assert.equal(
    response.body.includes(secret),
    false,
    `error_description leaked into response: ${response.body}`,
  )
  await app.close()
})
