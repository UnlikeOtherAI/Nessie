import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify, { type FastifyInstance } from 'fastify'

// The roster client builds its settings from the environment at call time, so
// this has to be in place before the route module is imported.
process.env.UOA_DOMAIN ??= 'api.example.test'
process.env.UOA_CONFIG_URL ??= 'https://api.example.test/api/auth/sso/config'
process.env.UOA_JWKS_URL ??= 'https://api.example.test/.well-known/jwks.json'
process.env.UOA_REDIRECT_URL ??= 'https://app.example.test/login'
process.env.UOA_CONFIG_JWT_KID ??= 'test-kid'
process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 ??= Buffer.from('not-a-real-key').toString('base64')
process.env.UOA_CLIENT_SECRET ??= 'test-client-secret'

const { registerTeamProvisioningRoutes } = await import('../src/routes/team-provisioning.js')
const {
  clearUoaTeamDirectoryCache,
  rememberUoaTeamDirectory,
} = await import('../src/services/uoa-directory-cache.js')

const BASE = 'nessie.test'
const MEMBER = 'user-member'
const OUTSIDER = 'user-outsider'

/**
 * `/api/hosts/team` answers *which team a hostname is*, and the standard
 * (docs/standards/team-hosts.md, "The tenant's address is the tenant's brand")
 * says a team address must never name its team to somebody who has not been
 * let in — which is the whole reason the route is authenticated rather than
 * public, while `/api/hosts/resolve` beside it is not.
 *
 * It did not enforce that. Any account on the instance could walk
 * `<guess>.<org>.<base>` and be told, for each guess, whether that team exists
 * and what its UOA organisation and team ids are. Found by an adversarial
 * review of the cross-tenant switching work (PR #535).
 *
 * The ids are not a grant — the switch behind them re-checks live membership
 * and fails closed — so this is a disclosure defect, not an access one. The
 * disclosure is the point: a guessable address must not be confirmable.
 */

/** UOA holds one organisation, `acme`, with one team, `design`. */
const uoaFetch = (calls: string[]) => async (url: URL): Promise<Response> => {
  calls.push(url.pathname)
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (url.pathname === '/domain/teams/resolve') {
    return url.searchParams.get('team') === 'design' && url.searchParams.get('org') === 'acme'
      ? json(200, { ok: true, team_id: 'uoa-team-design', org_id: 'uoa-org-acme' })
      : json(404, { ok: false, error: 'NOT_FOUND' })
  }
  return json(404, { ok: false, error: 'NOT_FOUND' })
}

type LocalTeamRow = {
  externalOrgId: string
  externalTeamId: string
  memberIds: string[]
}

/**
 * Only what the cold-cache fallback reads: this person's own `TeamMember` rows
 * joined to the UOA ids written when that team was materialized locally.
 */
const fakePrisma = (rows: LocalTeamRow[]) => ({
  team: {
    findMany: async ({ where }: { where: { members: { some: { userId: string } } } }) =>
      rows
        .filter((row) => row.memberIds.includes(where.members.some.userId))
        .map((row) => ({
          externalOrgId: row.externalOrgId,
          externalTeamId: row.externalTeamId,
          name: 'Design',
          project: { organization: { name: 'Acme' } },
        })),
  },
})

const buildApp = ({
  calls = [] as string[],
  localTeams = [] as LocalTeamRow[],
  uoa = true,
  userId = MEMBER,
} = {}): FastifyInstance => {
  const app = Fastify({ logger: false })
  registerTeamProvisioningRoutes(
    app,
    {
      prisma: fakePrisma(localTeams) as never,
      requireActorContext: () => ({
        actor: { actorType: 'user', actorId: userId },
        tenant: { organizationId: 'local-org' },
        actionContext: {
          requestId: 'req-1',
          ...(uoa
            ? {
              uoaIdentity: {
                subject: 'uoa-subject',
                organizationId: 'uoa-org-acme',
                teamId: 'uoa-team-design',
                tokenVersion: 1,
              },
            }
            : {}),
        },
      }),
      requireUserActor: () => true,
      teamHostBaseDomain: BASE,
      tlsCheckKey: undefined,
    } as never,
    {
      fetchImpl: uoaFetch(calls) as never,
      resolveHost: (async () => ['93.184.216.34']) as never,
    },
    // No upstream freshness read: every case below states the directory it
    // means, and a refresh would replace it with a network answer.
    { settings: null },
  )
  return app
}

const ask = async (app: FastifyInstance, host: string) =>
  app.inject({ method: 'GET', url: `/api/hosts/team?host=${encodeURIComponent(host)}` })

const rememberMembershipOf = (userId: string, teams: Array<[string, string]>): void => {
  rememberUoaTeamDirectory(userId, {
    entries: teams.map(([organizationId, teamId]) => ({
      organizationId,
      teamId,
      label: 'Design',
    })),
    pendingInvites: [],
  } as never)
}

test('a member of the team behind the address gets its ids', async () => {
  clearUoaTeamDirectoryCache()
  rememberMembershipOf(MEMBER, [['uoa-org-acme', 'uoa-team-design']])
  const app = buildApp({ userId: MEMBER })
  try {
    const response = await ask(app, `design.acme.${BASE}`)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().data.team, {
      externalOrgId: 'uoa-org-acme',
      externalTeamId: 'uoa-team-design',
    })
  } finally {
    clearUoaTeamDirectoryCache()
    await app.close()
  }
})

test('a signed-in non-member is told nothing about it', async () => {
  clearUoaTeamDirectoryCache()
  // A real account on the instance, in a real team — just not this one.
  rememberMembershipOf(OUTSIDER, [['uoa-org-other', 'uoa-team-other']])
  const app = buildApp({ userId: OUTSIDER })
  try {
    const response = await ask(app, `design.acme.${BASE}`)
    assert.equal(response.statusCode, 200)
    assert.equal(
      response.json().data.team,
      null,
      'an outsider must not learn that this team exists, let alone its ids',
    )
  } finally {
    clearUoaTeamDirectoryCache()
    await app.close()
  }
})

/**
 * The refusal has to be the SAME answer a made-up hostname gets. A distinct
 * one — an error code, a different status, a different body — hands the
 * enumeration back through the side door, which is the shape of defect the
 * `tls-check` gate was already written to avoid.
 */
test('the refusal is indistinguishable from a team that does not exist', async () => {
  clearUoaTeamDirectoryCache()
  rememberMembershipOf(OUTSIDER, [['uoa-org-other', 'uoa-team-other']])
  const app = buildApp({ userId: OUTSIDER })
  try {
    const refused = await ask(app, `design.acme.${BASE}`)
    const absent = await ask(app, `finance.acme.${BASE}`)
    assert.equal(refused.statusCode, absent.statusCode)
    assert.equal(refused.body, absent.body)
  } finally {
    clearUoaTeamDirectoryCache()
    await app.close()
  }
})

/**
 * A team hostname is only meaningful for a UOA session — the ids exist to run
 * `POST /api/auth/uoa/team`, which refuses any other session outright. A
 * session with no UOA identity has no directory to check, so it gets nothing.
 */
test('a session with no UOA identity learns nothing', async () => {
  clearUoaTeamDirectoryCache()
  rememberMembershipOf(MEMBER, [['uoa-org-acme', 'uoa-team-design']])
  const app = buildApp({ uoa: false, userId: MEMBER })
  try {
    assert.equal((await ask(app, `design.acme.${BASE}`)).json().data.team, null)
  } finally {
    clearUoaTeamDirectoryCache()
    await app.close()
  }
})

/**
 * A cold cache — a fresh process, or another replica — must not open the door.
 * The fallback is the person's own local `TeamMember` rows, so it fails closed
 * for an outsider and still admits a member.
 */
test('a cold directory falls back to local membership, both ways', async () => {
  clearUoaTeamDirectoryCache()
  const localTeams: LocalTeamRow[] = [{
    externalOrgId: 'uoa-org-acme',
    externalTeamId: 'uoa-team-design',
    memberIds: [MEMBER],
  }]

  const outsiderApp = buildApp({ localTeams, userId: OUTSIDER })
  try {
    assert.equal((await ask(outsiderApp, `design.acme.${BASE}`)).json().data.team, null)
  } finally {
    await outsiderApp.close()
  }

  const memberApp = buildApp({ localTeams, userId: MEMBER })
  try {
    assert.deepEqual((await ask(memberApp, `design.acme.${BASE}`)).json().data.team, {
      externalOrgId: 'uoa-org-acme',
      externalTeamId: 'uoa-team-design',
    })
  } finally {
    clearUoaTeamDirectoryCache()
    await memberApp.close()
  }
})

/**
 * The membership check runs against a hostname that resolved, so an outsider's
 * probe still costs one UOA read. That is why the rate limit matters as well
 * as the check — but it must not cost more than one.
 */
test('a probe costs one upstream read, not several', async () => {
  clearUoaTeamDirectoryCache()
  rememberMembershipOf(OUTSIDER, [['uoa-org-other', 'uoa-team-other']])
  const calls: string[] = []
  const app = buildApp({ calls, userId: OUTSIDER })
  try {
    await ask(app, `design.acme.${BASE}`)
    assert.deepEqual(calls, ['/domain/teams/resolve'])
  } finally {
    clearUoaTeamDirectoryCache()
    await app.close()
  }
})

/**
 * The membership check refuses each guess; the limit bounds how many guesses a
 * signed-in account gets to make. Both matter: the check alone still lets an
 * attacker probe the whole slug space and read the timing or the upstream
 * load, and a limit alone would still answer the guesses it allows.
 */
test('the route carries a rate-limit bucket of its own', async () => {
  const { resolveGlobalRateLimitBucket } = await import('../src/routes/auth-rate-limit.js')
  assert.equal(
    resolveGlobalRateLimitBucket({
      isPublic: false,
      method: 'GET',
      routePath: '/api/hosts/team',
    }),
    'hostsTeamIp',
  )
  // Not a bucket borrowed from an unrelated family, and not the public
  // fallback — this route is authenticated, so it would have had none at all.
  assert.equal(
    resolveGlobalRateLimitBucket({
      isPublic: false,
      method: 'GET',
      routePath: '/api/hosts/resolve',
    }),
    null,
  )
})
