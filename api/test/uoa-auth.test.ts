import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import {
  buildConfigJwt,
  buildUoaAuthorizeUrl,
  loadUoaSettings,
} from '../src/services/uoa-auth.js'
import type { SafeFetchOptions } from '@nessie/runtime'

import {
  exchangeUoaCode,
  exchangeUoaSession,
  resolveUoaIdentityFromAccessToken,
} from '../src/services/uoa-session.js'

// The UOA login egress goes through safeFetch (validated + IP-pinned, no
// redirect following); stub DNS at that seam so tests stay hermetic while the
// pinned transport itself still runs.
const safeFetchTestOptions: SafeFetchOptions = {
  resolveHost: async () => ['93.184.216.34'],
}
import { resolveExternalTeamSelection } from '../src/services/identity-display.js'

const testPrivateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

const uoaEnv = {
  UOA_BASE_URL: 'https://1.1.1.1',
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

const clientHash = createHash('sha256')
  .update(`${uoaEnv.UOA_DOMAIN}${uoaEnv.UOA_CLIENT_SECRET}`)
  .digest('hex')

const completeSessionClaims = {
  active: { orgId: 'org-active', teamId: 'team-active' },
  client_id: clientHash,
  domain: uoaEnv.UOA_DOMAIN,
  email: 'ada.lovelace@example.com',
  org: {
    org_id: 'org-active',
    org_role: 'member',
    team_roles: { 'team-active': 'member' },
    teams: ['team-active'],
  },
  sub: 'uoa-user-123',
  tv: 7,
} as const

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
  expectedUrl = 'https://1.1.1.1/auth/token?config_url=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fsso%2Fconfig',
): Promise<T> => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/org/me') {
      assert.equal(init?.method, undefined)
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${clientHash}`)
      assert.match(new Headers(init?.headers).get('x-uoa-access-token') ?? '', /^Bearer /)
      assert.equal(url.searchParams.get('domain'), uoaEnv.UOA_DOMAIN)
      return new Response(JSON.stringify({
        ok: true,
        org: {
          // `team_directory`, not `teams`. UOA sends the legacy `teams` as an
          // array of id STRINGS from the JWT `org` claim; the objects a picker
          // is built from live here. This fixture used to put the objects
          // under `teams`, which agreed with the parser's own mistake and hid
          // the fact that the directory was empty in production.
          teams: ['team-active', 'team-other'],
          team_directory: [
            {
              avatarImageUrl: '/public/teams/team-active/avatar',
              orgId: 'org-active',
              orgName: 'Active org',
              teamId: 'team-active',
              name: 'Active team',
            },
            {
              avatarImageUrl: 'https://images.example.com/teams/team-other.png',
              orgId: 'org-other',
              orgName: 'Other org',
              teamId: 'team-other',
              name: 'Other team',
            },
            {
              avatarImageUrl: 'data:image/png;base64,unsafe',
              orgId: 'org-other',
              orgName: 'Other org',
              teamId: 'team-unsafe-scheme',
              name: 'Unsafe scheme team',
            },
            {
              avatarImageUrl: '//attacker.example/team.png',
              orgId: 'org-other',
              orgName: 'Other org',
              teamId: 'team-protocol-relative',
              name: 'Protocol-relative team',
            },
            {
              avatarImageUrl: String.raw`/\\attacker.example/team.png`,
              orgId: 'org-other',
              orgName: 'Other org',
              teamId: 'team-backslash-host',
              name: 'Backslash-host team',
            },
          ],
          pending_invites: [
            {
              inviteId: 'invite-valid',
              orgId: 'org-invited',
              teamId: 'team-invited',
              teamName: 'Invited team',
              invitedBy: 'Grace Hopper',
              expiresAt: '2026-09-30T12:00:00.000Z',
            },
            { inviteId: 'invite-missing-org', teamId: 'team-bad', teamName: 'Bad' },
            null,
          ],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    assert.equal(String(input), expectedUrl)
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${clientHash}`)
    return new Response(
      JSON.stringify({
        access_token: jwtForClaims({ ...completeSessionClaims, ...claims }),
        expires_in: 1_800,
        refresh_token: 'uoa-refresh-1',
        refresh_token_expires_in: 2_592_000,
        token_type: 'Bearer',
      }),
      {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
      },
    )
  }

  try {
    return await fn()
  } finally {
    globalThis.fetch = previousFetch
  }
}

test('exchangeUoaCode reports no name when UOA asserted none', async () => {
  // Nothing is manufactured from the address any more: UOA owns the profile,
  // so an absent name claim leaves the local mirror alone.
  await withUoaEnv(async () => {
    await withTokenResponse({ email: 'ada.lovelace@example.com' }, async () => {
      const identity = await exchangeUoaCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: uoaEnv.UOA_REDIRECT_URL,
      }, safeFetchTestOptions)

      assert.equal(identity.displayName, undefined)
      assert.equal(identity.email, 'ada.lovelace@example.com')
    })
  })
})

test('exchangeUoaSession retains the exact server-side refresh session', async () => {
  await withUoaEnv(async () => {
    await withTokenResponse({}, async () => {
      const exchange = await exchangeUoaSession({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: uoaEnv.UOA_REDIRECT_URL,
      }, safeFetchTestOptions)

      assert.equal(exchange.configUrl, uoaEnv.UOA_CONFIG_URL)
      assert.equal(exchange.refreshToken, 'uoa-refresh-1')
      assert.equal(exchange.refreshTokenExpiresInSeconds, 2_592_000)
      assert.equal(exchange.identity.externalSubject, 'uoa-user-123')
      assert.equal(exchange.identity.uoaTokenVersion, 7)
      assert.deepEqual(resolveExternalTeamSelection(exchange.identity.team), {
        organizationId: 'org-active',
        teamId: 'team-active',
      })
      assert.deepEqual(exchange.teamDirectory, {
        entries: [{
          organizationId: 'org-active',
          teamId: 'team-active',
          avatarImageUrl: 'https://1.1.1.1/public/teams/team-active/avatar',
          label: 'Active team',
          orgName: 'Active org',
        }, {
          organizationId: 'org-other',
          teamId: 'team-other',
          avatarImageUrl: 'https://images.example.com/teams/team-other.png',
          label: 'Other team',
          orgName: 'Other org',
        }, {
          organizationId: 'org-other',
          teamId: 'team-unsafe-scheme',
          label: 'Unsafe scheme team',
          orgName: 'Other org',
        }, {
          organizationId: 'org-other',
          teamId: 'team-protocol-relative',
          label: 'Protocol-relative team',
          orgName: 'Other org',
        }, {
          organizationId: 'org-other',
          teamId: 'team-backslash-host',
          label: 'Backslash-host team',
          orgName: 'Other org',
        }],
        pendingInvites: [{
          inviteId: 'invite-valid',
          organizationId: 'org-invited',
          teamId: 'team-invited',
          teamName: 'Invited team',
          invitedBy: 'Grace Hopper',
          expiresAt: '2026-09-30T12:00:00.000Z',
        }],
      })
    })
  })
})

test('exchangeUoaSession treats an absent pending_invites field as verified empty', async () => {
  await withUoaEnv(async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (input) => new URL(String(input)).pathname === '/org/me'
      ? new Response(JSON.stringify({ org: { team_directory: [] } }), { status: 200 })
      : new Response(JSON.stringify({
          access_token: jwtForClaims(completeSessionClaims),
          expires_in: 1_800,
          refresh_token: 'uoa-refresh-1',
          refresh_token_expires_in: 2_592_000,
          token_type: 'Bearer',
        }), { status: 200 })
    try {
      const exchange = await exchangeUoaSession({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: uoaEnv.UOA_REDIRECT_URL,
      }, safeFetchTestOptions)
      assert.deepEqual(exchange.teamDirectory, { entries: [], pendingInvites: [] })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

test('exchangeUoaSession rejects an incomplete multi-team selection', async () => {
  await withUoaEnv(async () => {
    await withTokenResponse({
      active: undefined,
      org: {
        org_id: 'org-active',
        org_role: 'member',
        team_roles: { 'team-one': 'member', 'team-two': 'member' },
        teams: ['team-one', 'team-two'],
      },
    }, async () => {
      await assert.rejects(
        exchangeUoaSession({
          code: 'code',
          codeVerifier: 'verifier',
          redirectUri: uoaEnv.UOA_REDIRECT_URL,
        }, safeFetchTestOptions),
        /incomplete session proof/,
      )
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

test('buildConfigJwt requests UOA team features', async () => {
  await withUoaEnv(async () => {
    const payload = decodeJwtPayload(buildConfigJwt(loadUoaSettings()))

    assert.deepEqual(payload.org_features, {
      allow_user_create_org: true,
      allow_user_create_team: true,
      // Backend mode for the roster/invitation relay: without it UOA answers
      // 401 MISSING_ACCESS_TOKEN to every `/org/*` call Nessie makes.
      backend_org_management: true,
      capabilities: ['nessie.organisation.manage'],
      enabled: true,
      role_grants: {
        org: {
          admin: [
            'members.manage',
            'teams.manage',
            'organisation.manage',
            'nessie.organisation.manage',
          ],
        },
        team: { admin: ['members.manage', 'teams.manage'] },
      },
    })
    // Slack-style team chooser must be requested so UOA issues the
    // `active { orgId, teamId }` claim Nessie routes on.
    assert.deepEqual(payload.login_flow, {
      email_code_enabled: true,
      team_selection: 'auto',
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
        }, safeFetchTestOptions)

        assert.equal(identity.email, 'ada.lovelace@example.com')
      },
      'https://1.1.1.1/auth/token?config_url=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fsso%2Fconfig%3Ftheme%3Drose',
    )
  })
})

test('resolveUoaIdentityFromAccessToken decodes UOA team claims', () => {
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
    tv: 7,
  }))

  assert.equal(identity.displayName, 'Ada Lovelace')
  assert.equal(identity.email, 'ada.lovelace@example.com')
  assert.equal(identity.externalSubject, 'uoa-user-123')
  assert.equal(identity.uoaTokenVersion, 7)
  assert.deepEqual(identity.team, {
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

test('rejects malformed UOA token-version claims', () => {
  for (const tv of [-1, 1.5, '7']) {
    assert.throws(
      () => resolveUoaIdentityFromAccessToken(jwtForClaims({
        email: 'ada.lovelace@example.com',
        tv,
      })),
      /invalid tv claim/,
    )
  }
})

test('sole-team UOA sessions resolve the same team without an active claim', () => {
  const identity = resolveUoaIdentityFromAccessToken(jwtForClaims({
    email: 'ada.lovelace@example.com',
    org: {
      org_id: 'org-only',
      org_role: 'owner',
      team_roles: { 'team-only': 'owner' },
      teams: ['team-only'],
    },
    sub: 'uoa-user-123',
  }))

  assert.deepEqual(resolveExternalTeamSelection(identity.team), {
    organizationId: 'org-only',
    teamId: 'team-only',
  })
})

test('multi-team UOA sessions require an explicit active team', () => {
  assert.deepEqual(resolveExternalTeamSelection({
    orgId: 'org-many',
    teamIds: ['team-one', 'team-two'],
    teamRoles: {},
  }), {
    organizationId: 'org-many',
    teamId: null,
  })
})

test('exchangeUoaCode ignores a name claim that is just the email address', async () => {
  // Echoing the address is not an assertion about the person's name, so it
  // must not overwrite a real name on the next profile sync.
  await withUoaEnv(async () => {
    await withTokenResponse({
      email: 'ada.lovelace@example.com',
      name: 'ada.lovelace@example.com',
    }, async () => {
      const identity = await exchangeUoaCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: uoaEnv.UOA_REDIRECT_URL,
      }, safeFetchTestOptions)

      assert.equal(identity.displayName, undefined)
    })
  })
})
