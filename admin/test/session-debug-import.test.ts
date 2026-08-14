import assert from 'node:assert/strict'
import test from 'node:test'
import type { MeResponse } from '@nessie/schemas'
import type { AuthSessionApi } from '@nessie/client-core'
import {
  parseSessionDebugImport,
  resolveImportedSession,
  shouldStartAutomaticSignIn,
} from '../src/lib/session-debug-import'

const accessToken = 'header.payload.signature'

const debugDump = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  apiBaseUrl: 'https://api.nessie.test/',
  tokens: {
    accessToken,
    accessTokenDecoded: { role: 'spoofed-owner' },
    refreshToken: '(httpOnly cookie)',
  },
  session: { sessionId: 'untrusted-session' },
  context: { organizationId: 'untrusted-org' },
  user: { id: 'untrusted-user' },
  localStorage: { 'nessie.admin.token': accessToken, unrelated: 'do-not-import' },
  cookies: { unrelated: 'do-not-import' },
  ...overrides,
})

test('session debug import extracts only the bearer from the current API dump', () => {
  assert.deepEqual(
    parseSessionDebugImport(debugDump(), 'https://api.nessie.test'),
    { accessToken },
  )
})

test('session debug import normalizes a trailing slash but rejects another server', () => {
  assert.equal(
    parseSessionDebugImport(debugDump(), 'https://api.nessie.test/').accessToken,
    accessToken,
  )

  const secret = 'secret-token-that-must-not-appear-in-errors'
  assert.throws(
    () => parseSessionDebugImport(
      debugDump({
        apiBaseUrl: 'https://other.nessie.test',
        tokens: { accessToken: secret },
        localStorage: {},
      }),
      'https://api.nessie.test',
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /different Nessie server/)
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    },
  )
})

test('session debug import rejects malformed, missing, and conflicting credentials', () => {
  assert.throws(
    () => parseSessionDebugImport('', 'https://api.nessie.test'),
    /Paste a session debug JSON dump/,
  )
  assert.throws(
    () => parseSessionDebugImport('{', 'https://api.nessie.test'),
    /Paste valid session debug JSON/,
  )
  assert.throws(
    () => parseSessionDebugImport('[]', 'https://api.nessie.test'),
    /does not contain an access token/,
  )
  assert.throws(
    () => parseSessionDebugImport(
      debugDump({ tokens: { accessToken: ' ' } }),
      'https://api.nessie.test',
    ),
    /does not contain a usable access token/,
  )
  assert.throws(
    () => parseSessionDebugImport(
      debugDump({ localStorage: { 'nessie.admin.token': 'another-token' } }),
      'https://api.nessie.test',
    ),
    /conflicting access tokens/,
  )
})

test('import validation applies the pasted bearer only with authoritative server identity', async () => {
  const authoritativeMe = { source: 'server' } as unknown as MeResponse
  let requestedToken: string | null = null
  const fetchSession: AuthSessionApi['fetchSession'] = async (token) => {
    requestedToken = token
    return { kind: 'authenticated', me: authoritativeMe }
  }

  const result = await resolveImportedSession(accessToken, fetchSession)

  assert.equal(requestedToken, accessToken)
  assert.deepEqual(result, { me: authoritativeMe, token: accessToken })
})

test('expired and bootstrap sessions never produce an importable payload', async () => {
  await assert.rejects(
    resolveImportedSession(accessToken, async () => ({ kind: 'unauthenticated' })),
    /expired or was revoked/,
  )
  await assert.rejects(
    resolveImportedSession(
      accessToken,
      async () => ({
        bootstrap: { bootstrapMode: true, bootstrapTokenRequired: true },
        kind: 'bootstrap',
      }),
    ),
    /cannot be imported/,
  )
})

test('an open import dialog suppresses automatic SSO until it closes', () => {
  const ready = {
    callbackInUrl: false,
    hasAutoRedirectProvider: true,
    unauthenticated: true,
  }
  assert.equal(shouldStartAutomaticSignIn({ ...ready, sessionImportOpen: false }), true)
  assert.equal(shouldStartAutomaticSignIn({ ...ready, sessionImportOpen: true }), false)
})
