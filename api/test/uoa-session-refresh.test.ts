import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import {
  refreshUoaSession,
  UoaSessionRefreshError,
} from '../src/services/uoa-session.js'
import { resolveExternalWorkspaceSelection } from '../src/services/identity-display.js'

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

test('refreshUoaSession sends the exact refresh contract and accepts a monotonic epoch', async () => {
  await withUoaEnv(async () => {
    const urls: string[] = []
    const refreshed = await refreshUoaSession({
      configUrl: uoaEnv.UOA_CONFIG_URL,
      expectedIdentity: {
        organizationId: 'org-active',
        subject: 'uoa-user-123',
        teamId: 'team-active',
        tokenVersion: 7,
      },
      refreshToken: 'uoa-refresh-1',
      fetchImpl: async (input, init) => {
        urls.push(String(input))
        if (new URL(String(input)).pathname === '/org/me') {
          assert.match(
            new Headers(init?.headers).get('x-uoa-access-token') ?? '',
            /^Bearer /,
          )
          return new Response(JSON.stringify({
            org: {
              workspaces: [{
                avatarImageUrl: '/teams/team-active/avatar',
                name: 'Fresh workspace',
                orgId: 'org-active',
                orgName: 'Fresh org',
                teamId: 'team-active',
              }],
            },
          }), { status: 200 })
        }
        assert.equal(
          String(input),
          'https://1.1.1.1/auth/token?config_url=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fsso%2Fconfig',
        )
        assert.equal(init?.method, 'POST')
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('authorization'), `Bearer ${clientHash}`)
        assert.equal(headers.get('content-type'), 'application/json')
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grant_type: 'refresh_token',
          refresh_token: 'uoa-refresh-1',
        })
        return new Response(JSON.stringify({
          access_token: jwtForClaims({ ...completeSessionClaims, tv: 8 }),
          expires_in: 1_800,
          refresh_token: 'uoa-refresh-2',
          refresh_token_expires_in: 2_592_000,
          token_type: 'Bearer',
        }), { status: 200 })
      },
    })

    assert.equal(refreshed.refreshToken, 'uoa-refresh-2')
    assert.equal(refreshed.identity.uoaTokenVersion, 8)
    assert.deepEqual(refreshed.workspaceDirectory, [{
      avatarImageUrl: 'https://1.1.1.1/teams/team-active/avatar',
      label: 'Fresh workspace',
      organizationId: 'org-active',
      orgName: 'Fresh org',
      teamId: 'team-active',
    }])
    assert.equal(urls.length, 2)
  })
})

test('refreshUoaSession retains the caller directory when its optional read fails', async () => {
  await withUoaEnv(async () => {
    let calls = 0
    const refreshed = await refreshUoaSession({
      configUrl: uoaEnv.UOA_CONFIG_URL,
      expectedIdentity: {
        organizationId: 'org-active',
        subject: 'uoa-user-123',
        teamId: 'team-active',
        tokenVersion: 7,
      },
      refreshToken: 'uoa-refresh-1',
      fetchImpl: async () => {
        calls += 1
        if (calls === 2) return new Response(null, { status: 503 })
        return new Response(JSON.stringify({
          access_token: jwtForClaims({ ...completeSessionClaims, tv: 8 }),
          expires_in: 1_800,
          refresh_token: 'uoa-refresh-2',
          refresh_token_expires_in: 2_592_000,
          token_type: 'Bearer',
        }), { status: 200 })
      },
    })

    assert.equal(refreshed.workspaceDirectory, undefined)
    assert.equal(calls, 2)
  })
})

test('refreshUoaSession sends the explicit workspace-switch grant and requires the exact target', async () => {
  await withUoaEnv(async () => {
    const refreshed = await refreshUoaSession({
      configUrl: uoaEnv.UOA_CONFIG_URL,
      expectedIdentity: {
        organizationId: 'org-active',
        subject: 'uoa-user-123',
        teamId: 'team-active',
        tokenVersion: 7,
      },
      refreshToken: 'uoa-refresh-1',
      workspaceSwitch: {
        organizationId: 'org-target',
        teamId: 'team-target',
      },
      fetchImpl: async (_input, init) => {
        assert.deepEqual(JSON.parse(String(init.body)), {
          grant_type: 'urn:unlikeotherai:params:oauth:grant-type:workspace-switch',
          organization_id: 'org-target',
          refresh_token: 'uoa-refresh-1',
          team_id: 'team-target',
        })
        return new Response(JSON.stringify({
          access_token: jwtForClaims({
            ...completeSessionClaims,
            active: { orgId: 'org-target', teamId: 'team-target' },
            org: {
              org_id: 'org-target',
              org_role: 'member',
              team_roles: { 'team-target': 'member' },
              teams: ['team-target'],
            },
            tv: 8,
          }),
          expires_in: 1_800,
          refresh_token: 'uoa-refresh-2',
          refresh_token_expires_in: 2_592_000,
          token_type: 'Bearer',
        }), { status: 200 })
      },
    })

    assert.equal(refreshed.refreshToken, 'uoa-refresh-2')
    assert.deepEqual(
      resolveExternalWorkspaceSelection(refreshed.identity.workspace),
      { organizationId: 'org-target', teamId: 'team-target' },
    )
  })
})

test('workspace-switch errors distinguish safe target refusals from an invalid source', async () => {
  await withUoaEnv(async () => {
    const baseInput = {
      configUrl: uoaEnv.UOA_CONFIG_URL,
      expectedIdentity: {
        organizationId: 'org-active',
        subject: 'uoa-user-123',
        teamId: 'team-active',
        tokenVersion: 7,
      },
      refreshToken: 'uoa-refresh-1',
      workspaceSwitch: {
        organizationId: 'org-target',
        teamId: 'team-target',
      },
    } as const
    for (const [status, code] of [
      [403, 'WORKSPACE_NOT_AVAILABLE'],
      [403, 'INTERACTION_REQUIRED'],
      [409, 'WORKSPACE_SWITCH_CONFLICT'],
    ] as const) {
      await assert.rejects(
        refreshUoaSession({
          ...baseInput,
          fetchImpl: async () => new Response(JSON.stringify({ code }), { status }),
        }),
        (error: unknown) =>
          error instanceof UoaSessionRefreshError
          && !error.definitive
          && error.safeWorkspaceSwitchFailure
          && error.upstreamCode === code,
      )
    }
    await assert.rejects(
      refreshUoaSession({
        ...baseInput,
        fetchImpl: async () => new Response(
          JSON.stringify({ error: 'WORKSPACE_NOT_AVAILABLE' }),
          { status: 503 },
        ),
      }),
      (error: unknown) =>
        error instanceof UoaSessionRefreshError
        && !error.definitive
        && !error.safeWorkspaceSwitchFailure,
    )
    await assert.rejects(
      refreshUoaSession({
        ...baseInput,
        fetchImpl: async () => new Response(
          JSON.stringify({ error: 'INVALID_REFRESH_TOKEN' }),
          { status: 401 },
        ),
      }),
      (error: unknown) =>
        error instanceof UoaSessionRefreshError
        && error.definitive
        && !error.safeWorkspaceSwitchFailure,
    )
  })
})

test('credential-bearing UOA session calls never follow redirects', async () => {
  await withUoaEnv(async () => {
    let calls = 0
    await assert.rejects(
      refreshUoaSession({
        configUrl: uoaEnv.UOA_CONFIG_URL,
        expectedIdentity: {
          organizationId: 'org-active',
          subject: 'uoa-user-123',
          teamId: 'team-active',
          tokenVersion: 7,
        },
        refreshToken: 'uoa-refresh-1',
        fetchImpl: async () => {
          calls += 1
          return new Response(null, {
            headers: { Location: 'https://attacker.example/steal' },
            status: 307,
          })
        },
      }),
      (error: unknown) =>
        error instanceof UoaSessionRefreshError && !error.definitive,
    )
    assert.equal(calls, 1)
  })
})

test('refreshUoaSession rejects changed identity and regressed epochs definitively', async () => {
  await withUoaEnv(async () => {
    for (const claims of [
      { sub: 'different-user' },
      { active: { orgId: 'different-org', teamId: 'team-active' } },
      { active: { orgId: 'org-active', teamId: 'different-team' } },
      { tv: 6 },
    ]) {
      await assert.rejects(
        refreshUoaSession({
          configUrl: uoaEnv.UOA_CONFIG_URL,
          expectedIdentity: {
            organizationId: 'org-active',
            subject: 'uoa-user-123',
            teamId: 'team-active',
            tokenVersion: 7,
          },
          refreshToken: 'uoa-refresh-1',
          fetchImpl: async () => new Response(JSON.stringify({
            access_token: jwtForClaims({ ...completeSessionClaims, ...claims }),
            expires_in: 1_800,
            refresh_token: 'uoa-refresh-2',
            refresh_token_expires_in: 2_592_000,
            token_type: 'Bearer',
          }), { status: 200 }),
        }),
        (error: unknown) =>
          error instanceof UoaSessionRefreshError && error.definitive,
      )
    }
  })
})

test('refreshUoaSession classifies stored-config and endpoint failures safely', async () => {
  await withUoaEnv(async () => {
    const expectedIdentity = {
      organizationId: 'org-active',
      subject: 'uoa-user-123',
      teamId: 'team-active',
      tokenVersion: 7,
    } as const

    await assert.rejects(
      refreshUoaSession({
        configUrl: 'https://attacker.example/config',
        expectedIdentity,
        refreshToken: 'uoa-refresh-1',
      }),
      (error: unknown) =>
        error instanceof UoaSessionRefreshError && error.definitive,
    )
    await assert.rejects(
      refreshUoaSession({
        configUrl: uoaEnv.UOA_CONFIG_URL,
        expectedIdentity,
        refreshToken: 'uoa-refresh-1',
        fetchImpl: async () => new Response(null, { status: 401 }),
      }),
      (error: unknown) =>
        error instanceof UoaSessionRefreshError && error.definitive,
    )
    for (const fetchImpl of [
      async () => new Response(null, { status: 503 }),
      async () => { throw new Error('network down') },
    ]) {
      await assert.rejects(
        refreshUoaSession({
          configUrl: uoaEnv.UOA_CONFIG_URL,
          expectedIdentity,
          refreshToken: 'uoa-refresh-1',
          fetchImpl,
        }),
        (error: unknown) =>
          error instanceof UoaSessionRefreshError && !error.definitive,
      )
    }
  })
})
