import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import {
  buildConfigJwt,
  buildUoaAuthorizeUrl,
  exchangeUoaCode,
  loadUoaSettings,
  resolveUoaIdentityFromAccessToken,
} from '../src/services/uoa-auth.js'

const testPrivateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.example.com',
  UOA_CLIENT_SECRET: 'client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(testPrivateKeyPem).toString('base64'),
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

const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  assert.ok(payload)
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

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
  expectedUrl = 'https://uoa.example.com/auth/token?config_url=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fsso%2Fconfig',
): Promise<T> => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.equal(String(input), expectedUrl)
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

test('buildConfigJwt uses the selected hosted-login theme palette', async () => {
  await withUoaEnv(async () => {
    const payload = decodeJwtPayload(buildConfigJwt(loadUoaSettings(), 'ocean'))
    const uiTheme = payload.ui_theme as { colors: Record<string, string> }

    assert.equal(uiTheme.colors.primary, '#0e7490')
    assert.equal(uiTheme.colors.bg, '#0b1a22')
    assert.equal(uiTheme.colors.surface, '#102733')
  })
})

test('buildConfigJwt requests UOA workspace features', async () => {
  await withUoaEnv(async () => {
    const payload = decodeJwtPayload(buildConfigJwt(loadUoaSettings()))

    assert.deepEqual(payload.org_features, {
      allow_user_create_org: true,
      enabled: true,
    })
    // Slack-style workspace chooser must be requested so UOA issues the
    // `active { orgId, teamId }` claim Nessie routes on.
    assert.deepEqual(payload.login_flow, {
      email_code_enabled: true,
      workspace_selection: 'auto',
    })
  })
})

test('buildUoaAuthorizeUrl passes the selected theme through config_url', async () => {
  await withUoaEnv(async () => {
    const authorizeUrl = new URL(buildUoaAuthorizeUrl({
      codeChallenge: 'challenge',
      redirectUri: uoaEnv.UOA_REDIRECT_URL,
      theme: 'rose',
    }))

    const configUrl = authorizeUrl.searchParams.get('config_url')
    assert.equal(configUrl, 'https://api.example.com/api/auth/sso/config?theme=rose')
  })
})

test('exchangeUoaCode reuses the selected theme for the token config_url', async () => {
  await withUoaEnv(async () => {
    await withTokenResponse(
      { email: 'ada.lovelace@example.com' },
      async () => {
        const identity = await exchangeUoaCode({
          code: 'code',
          codeVerifier: 'verifier',
          redirectUri: uoaEnv.UOA_REDIRECT_URL,
          theme: 'rose',
        })

        assert.equal(identity.email, 'ada.lovelace@example.com')
      },
      'https://uoa.example.com/auth/token?config_url=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fsso%2Fconfig%3Ftheme%3Drose',
    )
  })
})

test('resolveUoaIdentityFromAccessToken decodes UOA workspace claims', () => {
  const identity = resolveUoaIdentityFromAccessToken(jwtForClaims({
    active: { orgId: 'org-active', teamId: 'team-active' },
    email: 'Ada.Lovelace@Example.com ',
    name: 'Ada Lovelace',
    org: {
      org_id: 'org-default',
      org_role: 'admin',
      team_roles: {
        'team-active': 'owner',
        'team-other': 'member',
      },
      teams: ['team-active', 'team-other'],
    },
    sub: 'uoa-user-123',
  }))

  assert.equal(identity.displayName, 'Ada Lovelace')
  assert.equal(identity.email, 'ada.lovelace@example.com')
  assert.equal(identity.externalSubject, 'uoa-user-123')
  assert.deepEqual(identity.workspace, {
    activeOrgId: 'org-active',
    activeTeamId: 'team-active',
    orgId: 'org-default',
    orgRole: 'admin',
    teamIds: ['team-active', 'team-other'],
    teamRoles: {
      'team-active': 'owner',
      'team-other': 'member',
    },
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
