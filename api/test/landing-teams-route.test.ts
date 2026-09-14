import assert from 'node:assert/strict'
import test from 'node:test'

import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'

import { REFRESH_COOKIE_NAME } from '../src/lib/refresh-cookie.js'
import { createCorsOriginChecker } from '../src/lib/server-origin-policy.js'
import { LANDING_TEAMS_PATH, registerAuthLandingTeamsRoute } from '../src/routes/auth-landing-teams.js'
import {
  clearUoaTeamDirectoryCache,
  rememberUoaTeamDirectory,
} from '../src/services/uoa-directory-cache.js'
import { hashRefreshToken } from '../src/services/refresh-token-crypto.js'

const LANDING = 'https://nessie.works'
const APP = 'https://app.nessie.works'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const SESSION_A = '33333333-3333-4333-8333-333333333333'
const FAMILY_A = '44444444-4444-4444-8444-444444444444'
const TOKEN_ROW_A = '55555555-5555-4555-8555-555555555555'

type TokenRow = {
  id: string
  userId: string
  familyId: string
  sessionId: string
  providerId: string
  providerType: string
  tokenHash: string
  revokedAt: Date | null
  replacedById: string | null
  replayProtectedUntil: Date | null
  expiresAt: Date
}

const tokenRow = (rawToken: string, overrides: Partial<TokenRow> = {}): TokenRow => ({
  id: TOKEN_ROW_A,
  userId: USER_A,
  familyId: FAMILY_A,
  sessionId: SESSION_A,
  providerId: 'local',
  providerType: 'local-bootstrap',
  tokenHash: hashRefreshToken(rawToken),
  revokedAt: null,
  replacedById: null,
  replayProtectedUntil: null,
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
})

/**
 * Two people's memberships in one store, so "only that person's teams" is a
 * property the query has to earn rather than the fixture handing it over.
 */
const createFakePrisma = (input: {
  tokens: TokenRow[]
  revokedSessions?: string[]
  uoa?: boolean
}) => {
  const orgMembers = [
    { userId: USER_A, organizationId: '66666666-6666-4666-8666-666666666661', role: 'owner', organization: { id: '66666666-6666-4666-8666-666666666661', name: 'Acme' } },
    { userId: USER_B, organizationId: '66666666-6666-4666-8666-666666666662', role: 'owner', organization: { id: '66666666-6666-4666-8666-666666666662', name: 'Other Co' } },
  ]
  const projectMembers = [
    { userId: USER_A, projectId: '77777777-7777-4777-8777-777777777771', project: { id: '77777777-7777-4777-8777-777777777771', name: 'Acme', organizationId: '66666666-6666-4666-8666-666666666661' } },
    { userId: USER_B, projectId: '77777777-7777-4777-8777-777777777772', project: { id: '77777777-7777-4777-8777-777777777772', name: 'Other', organizationId: '66666666-6666-4666-8666-666666666662' } },
  ]
  const teamMembers = [
    { userId: USER_A, teamId: '88888888-8888-4888-8888-888888888881', createdAt: new Date(1), team: { id: '88888888-8888-4888-8888-888888888881', name: 'Design', project: { id: '77777777-7777-4777-8777-777777777771', teamId: null }, projects: [] } },
    { userId: USER_A, teamId: '88888888-8888-4888-8888-888888888882', createdAt: new Date(2), team: { id: '88888888-8888-4888-8888-888888888882', name: 'Sales', project: { id: '77777777-7777-4777-8777-777777777771', teamId: null }, projects: [] } },
    { userId: USER_B, teamId: '88888888-8888-4888-8888-888888888883', createdAt: new Date(0), team: { id: '88888888-8888-4888-8888-888888888883', name: 'Secret', project: { id: '77777777-7777-4777-8777-777777777772', teamId: null }, projects: [] } },
  ]
  type Where = { where: { userId: string } }
  return {
    refreshToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        input.tokens.find((row) => row.tokenHash === where.tokenHash) ?? null,
    },
    authSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        input.revokedSessions?.includes(where.id) ? { revokedAt: new Date() } : null,
    },
    organizationMember: {
      findMany: async ({ where }: Where) => orgMembers.filter((row) => row.userId === where.userId),
    },
    projectMember: {
      findMany: async ({ where }: Where) => projectMembers.filter((row) => row.userId === where.userId),
    },
    teamMember: {
      findMany: async ({ where }: Where) => teamMembers.filter((row) => row.userId === where.userId),
      findFirst: async ({ where }: Where) =>
        [...teamMembers]
          .filter((row) => row.userId === where.userId)
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0] ?? null,
    },
    uoaSessionCredential: {
      findUnique: async ({ where }: { where: { familyId: string } }) => input.uoa && where.familyId === FAMILY_A
        ? {
            familyId: FAMILY_A,
            userId: USER_A,
            providerId: 'uoa',
            subject: 'uoa-subject-a',
            organizationId: 'uoa-org-acme',
            teamId: 'uoa-team-design',
            tokenVersion: 3,
            configUrl: 'https://authentication.unlikeotherai.com/config',
            refreshTokenHash: 'h',
            refreshTokenCiphertext: 'c',
            refreshTokenIv: 'i',
            refreshTokenAuthTag: 't',
            refreshTokenExpiresAt: new Date(Date.now() + 60_000),
            lastLocalTokenId: TOKEN_ROW_A,
            generation: 1,
          }
        : null,
    },
    team: {
      // `resolveUoaLocalSessionContext` → the local team the UOA session proves.
      findFirst: async () => ({
        id: '88888888-8888-4888-8888-888888888881',
        projectId: '77777777-7777-4777-8777-777777777771',
        project: { id: '77777777-7777-4777-8777-777777777771', organizationId: '66666666-6666-4666-8666-666666666661', organization: { members: [{ role: 'owner' }] } },
      }),
      // `addLocalTeamAvatarIds`: no local avatar relay ids in this fixture.
      findMany: async () => [],
    },
    productAccountLink: {
      findUnique: async () => ({ id: 'link-a', status: 'linked', uoaSub: 'uoa-subject-a', uoaTokenVersion: 3 }),
    },
  }
}

const buildApp = async (
  prisma: ReturnType<typeof createFakePrisma>,
  options: { landingOrigin?: string; teamHostBaseDomain?: string } = {},
): Promise<FastifyInstance> => {
  const app = Fastify()
  // The API-wide policy exactly as production registers it: the landing is
  // not in the allowlist, the app is.
  await app.register(cors, {
    credentials: true,
    origin: createCorsOriginChecker({
      allowedOrigins: new Set([APP]),
      mode: 'selfHosted',
      teamHostBaseDomain: options.teamHostBaseDomain,
    }),
  })
  await app.register(cookie)
  registerAuthLandingTeamsRoute(app, {
    prisma: prisma as never,
    landingOrigin: 'landingOrigin' in options ? options.landingOrigin : LANDING,
    teamHostBaseDomain: options.teamHostBaseDomain,
    adminOrigin: APP,
    resolveTeamAddress: async (teamId) =>
      teamId === 'uoa-team-design' ? { teamSlug: 'design', orgSlug: 'acme' } : null,
    uoaDirectoryRefreshDeps: { settings: null },
  })
  return app
}

const get = (app: FastifyInstance, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: LANDING_TEAMS_PATH, headers })

test('signed out: 200 with no teams, readable only by the landing origin', async () => {
  const app = await buildApp(createFakePrisma({ tokens: [] }))
  const response = await get(app, { origin: LANDING })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { data: { teams: [] } })
  assert.equal(response.headers['access-control-allow-origin'], LANDING)
  assert.equal(response.headers['access-control-allow-credentials'], 'true')
  assert.equal(response.headers['cache-control'], 'no-store')
  await app.close()
})

test('an unknown, revoked or expired cookie reads as signed out', async () => {
  const cases = [
    createFakePrisma({ tokens: [] }),
    createFakePrisma({ tokens: [tokenRow('raw-a', { revokedAt: new Date() })] }),
    createFakePrisma({ tokens: [tokenRow('raw-a', { expiresAt: new Date(Date.now() - 1) })] }),
    createFakePrisma({ tokens: [tokenRow('raw-a')], revokedSessions: [SESSION_A] }),
  ]
  for (const prisma of cases) {
    const app = await buildApp(prisma)
    const response = await get(app, { origin: LANDING, cookie: `${REFRESH_COOKIE_NAME}=raw-a` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { data: { teams: [] } })
    await app.close()
  }
})

test('any other origin is refused and gets no CORS grant — the app and tenant hosts included', async () => {
  const app = await buildApp(
    createFakePrisma({ tokens: [tokenRow('raw-a')] }),
    { teamHostBaseDomain: 'nessie.works' },
  )
  const refused = [
    {},
    { origin: 'https://evil.example' },
    { origin: 'https://nessie.works.attacker.test' },
    { origin: 'http://nessie.works' },
    { origin: APP },
    { origin: 'https://design.acme.nessie.works' },
  ]
  for (const headers of refused) {
    const response = await get(app, { ...headers, cookie: `${REFRESH_COOKIE_NAME}=raw-a` })
    assert.equal(response.statusCode, 403, JSON.stringify(headers))
    assert.equal(response.json().data, undefined)
    assert.notEqual(response.headers['access-control-allow-origin'], LANDING)
    if (headers.origin !== APP && headers.origin !== 'https://design.acme.nessie.works') {
      assert.equal(response.headers['access-control-allow-origin'], undefined, JSON.stringify(headers))
    }
  }
  await app.close()
})

test('no landing origin configured: the route answers nobody', async () => {
  const app = await buildApp(createFakePrisma({ tokens: [tokenRow('raw-a')] }), { landingOrigin: undefined })
  const response = await get(app, { origin: LANDING, cookie: `${REFRESH_COOKIE_NAME}=raw-a` })
  assert.equal(response.statusCode, 403)
  await app.close()
})

test('the global CORS policy still does not admit the landing anywhere else', async () => {
  const app = await buildApp(createFakePrisma({ tokens: [] }))
  app.get('/api/other', async () => ({ ok: true }))
  const response = await app.inject({ method: 'GET', url: '/api/other', headers: { origin: LANDING } })
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  await app.close()
})

test('signed in without an IdP: only that person\'s teams, first membership active, nothing extra on the wire', async () => {
  const app = await buildApp(createFakePrisma({ tokens: [tokenRow('raw-a')] }))
  const response = await get(app, { origin: LANDING, cookie: `${REFRESH_COOKIE_NAME}=raw-a` })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    data: {
      teams: [
        { label: 'Design', orgName: 'Acme', active: true, href: `${APP}/channels` },
        { label: 'Sales', orgName: 'Acme', active: false, href: `${APP}/channels` },
      ],
    },
  })
  assert.doesNotMatch(response.body, /Secret|Other Co|88888888-|66666666-|@/)
  await app.close()
})

test('signed in through UOA: the directory, active team first, each linking to its own address', async () => {
  clearUoaTeamDirectoryCache()
  rememberUoaTeamDirectory(USER_A, {
    entries: [
      { organizationId: 'uoa-org-acme', teamId: 'uoa-team-ops', label: 'Operations', orgName: 'Acme' },
      {
        organizationId: 'uoa-org-acme',
        teamId: 'uoa-team-design',
        label: 'Design',
        orgName: 'Acme',
        avatarImageUrl: 'https://authentication.unlikeotherai.com/teams/uoa-team-design/avatar',
      },
    ],
    pendingInvites: [],
  })
  const app = await buildApp(
    createFakePrisma({ tokens: [tokenRow('raw-a', { providerId: 'uoa', providerType: 'uoa' })], uoa: true }),
    { teamHostBaseDomain: 'nessie.works' },
  )
  try {
    const response = await get(app, { origin: LANDING, cookie: `${REFRESH_COOKIE_NAME}=raw-a` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      data: {
        teams: [
          {
            label: 'Design',
            orgName: 'Acme',
            avatarImageUrl: 'https://authentication.unlikeotherai.com/teams/uoa-team-design/avatar?size=128',
            active: true,
            href: 'https://design.acme.nessie.works/channels',
          },
          {
            label: 'Operations',
            orgName: 'Acme',
            avatarImageUrl: 'https://authentication.unlikeotherai.com/teams/uoa-team-ops/avatar?size=128',
            active: false,
            // No address known: the app's canonical origin.
            href: `${APP}/channels`,
          },
        ],
      },
    })
    assert.doesNotMatch(response.body, /uoa-subject-a|uoa-org-acme/)
  } finally {
    clearUoaTeamDirectoryCache()
    await app.close()
  }
})
