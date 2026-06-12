import assert from 'node:assert/strict'
import test from 'node:test'

import { exchangeUoaCode } from '../src/services/uoa-auth.js'

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.example.com',
  UOA_CLIENT_SECRET: 'client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from('unused-private-key').toString('base64'),
  UOA_CONFIG_URL: 'https://api.example.com/api/auth/sso/config',
  UOA_DOMAIN: 'api.example.com',
  UOA_JWKS_URL: 'https://api.example.com/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://app.example.com/login',
}

const jwtForClaims = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.')

const withUoaEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = Object.fromEntries(
    Object.keys(uoaEnv).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, uoaEnv)

  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

const withTokenResponse = async <T>(
  claims: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.equal(
      String(input),
      'https://uoa.example.com/auth/token?config_url=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fsso%2Fconfig',
    )
    return new Response(
      JSON.stringify({ access_token: jwtForClaims(claims) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  try {
    return await fn()
  } finally {
    globalThis.fetch = previousFetch
  }
}

test('exchangeUoaCode humanizes email-only identities', async () => {
  await withUoaEnv(async () => {
    await withTokenResponse({ email: 'ada.lovelace@example.com' }, async () => {
      const identity = await exchangeUoaCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: uoaEnv.UOA_REDIRECT_URL,
      })

      assert.equal(identity.displayName, 'Ada Lovelace')
      assert.equal(identity.email, 'ada.lovelace@example.com')
    })
  })
})

test('exchangeUoaCode ignores a name claim that is just the email address', async () => {
  await withUoaEnv(async () => {
    await withTokenResponse({
      email: 'ada.lovelace@example.com',
      name: 'ada.lovelace@example.com',
    }, async () => {
      const identity = await exchangeUoaCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: uoaEnv.UOA_REDIRECT_URL,
      })

      assert.equal(identity.displayName, 'Ada Lovelace')
    })
  })
})
