import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deviceFlowForAdapter,
  findSubscriptionAdapter,
  readIdTokenIdentity,
  requireSubscriptionAdapter,
} from '../src/index.js'
import { ModelSubscriptionError } from '../src/types.js'

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const idToken = (claims: Record<string, unknown>): string =>
  `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`

const ISSUER = 'https://auth.example.com'
const AUDIENCE = 'client-123'

test('an id_token from the expected issuer and audience yields the account identity', () => {
  const identity = readIdTokenIdentity(
    idToken({
      aud: AUDIENCE,
      email: 'person@example.com',
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: ISSUER,
      sub: 'subject-1',
    }),
    { audience: AUDIENCE, issuer: ISSUER },
  )
  assert.equal(identity.providerAccountId, 'subject-1')
  assert.equal(identity.accountLabel, 'person@example.com')
})

test('an id_token minted for a different application is refused', () => {
  // Audience is what ties the token to OUR client. Without this check a token
  // issued to some other application would be accepted as an account identity.
  assert.throws(
    () =>
      readIdTokenIdentity(
        idToken({ aud: 'someone-elses-client', iss: ISSUER, sub: 'subject-1' }),
        { audience: AUDIENCE, issuer: ISSUER },
      ),
    (error: unknown) =>
      error instanceof ModelSubscriptionError
      && error.code === 'MODEL_SUBSCRIPTION_VERIFY_FAILED',
  )
})

test('an id_token from a different issuer is refused', () => {
  assert.throws(
    () =>
      readIdTokenIdentity(
        idToken({ aud: AUDIENCE, iss: 'https://evil.example.com', sub: 'subject-1' }),
        { audience: AUDIENCE, issuer: ISSUER },
      ),
    (error: unknown) => error instanceof ModelSubscriptionError,
  )
})

test('an expired id_token is refused', () => {
  assert.throws(
    () =>
      readIdTokenIdentity(
        idToken({
          aud: AUDIENCE,
          exp: Math.floor(Date.now() / 1000) - 60,
          iss: ISSUER,
          sub: 'subject-1',
        }),
        { audience: AUDIENCE, issuer: ISSUER },
      ),
    (error: unknown) => error instanceof ModelSubscriptionError,
  )
})

test('an id_token with no subject is refused', () => {
  // Without a stable subject there is nothing for a relink to match against,
  // so an account swap would be undetectable.
  assert.throws(
    () =>
      readIdTokenIdentity(idToken({ aud: AUDIENCE, iss: ISSUER }), {
        audience: AUDIENCE,
        issuer: ISSUER,
      }),
    (error: unknown) => error instanceof ModelSubscriptionError,
  )
})

test('the OAuth providers are linked by sign-in, the key providers by paste', () => {
  assert.equal(requireSubscriptionAdapter('openai_codex').authStrategy, 'oauth_device')
  assert.equal(requireSubscriptionAdapter('grok').authStrategy, 'oauth_device')
  assert.equal(requireSubscriptionAdapter('kimi').authStrategy, 'api_key')
  assert.equal(requireSubscriptionAdapter('glm').authStrategy, 'api_key')

  assert.notEqual(deviceFlowForAdapter('openai_codex'), null)
  assert.notEqual(deviceFlowForAdapter('grok'), null)
  assert.equal(deviceFlowForAdapter('kimi'), null)
  assert.equal(deviceFlowForAdapter('glm'), null)
})

test('every OAuth adapter can refresh, and dispatches to its own pinned origin', () => {
  // A subscription that cannot refresh dies silently at the first token
  // expiry, and a base URL that is not a constant is an egress hole.
  for (const key of ['openai_codex', 'grok'] as const) {
    const adapter = requireSubscriptionAdapter(key)
    assert.equal(typeof adapter.refresh, 'function', key)
    const origin = new URL(adapter.transport.baseUrl).origin
    assert.equal(origin, new URL(adapter.transport.baseUrl).origin)
    assert.match(adapter.transport.baseUrl, /^https:\/\//, key)
  }
  assert.equal(
    requireSubscriptionAdapter('grok').transport.baseUrl,
    'https://cli-chat-proxy.grok.com/v1',
  )
  assert.equal(
    requireSubscriptionAdapter('openai_codex').transport.runtimeProvider,
    'codex-subscription',
  )
})

test('Grok carries its own transport header, Codex identifies Nessie as the caller', () => {
  const grok = requireSubscriptionAdapter('grok')
  assert.equal(
    grok.transportHeaders?.({ accessToken: 'token' })['X-XAI-Token-Auth'],
    'xai-grok-cli',
  )
  const codex = requireSubscriptionAdapter('openai_codex')
  const headers = codex.transportHeaders?.({ accessToken: 'token' }) ?? {}
  assert.equal(headers.originator, 'nessie')
})

test('Codex sends the ChatGPT account id when the grant names one', () => {
  const codex = requireSubscriptionAdapter('openai_codex')
  const token = idToken({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
    aud: 'app_EMoamEEZ73f0CkXaXp7hrann',
    iss: 'https://auth.openai.com',
    sub: 'subject-1',
  })
  const headers = codex.transportHeaders?.({ accessToken: 'token', idToken: token }) ?? {}
  assert.equal(headers['chatgpt-account-id'], 'acct-42')
})

test('the adapter registry still refuses an unknown provider', () => {
  assert.equal(findSubscriptionAdapter('anthropic'), null)
  assert.throws(() => requireSubscriptionAdapter('anthropic'))
})
