import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { registerTeamMembersRoutes } from '../src/routes/team-members.js'
import { buildConfigJwt, loadUoaSettings } from '../src/services/uoa-auth.js'
import { resolveUoaRosterTeam } from '../src/services/uoa-org-roster.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const localTeamId = '00000000-0000-4000-8000-000000000004'
const userId = '00000000-0000-4000-8000-00000000000a'
const externalOrgId = 'org_acme'
const externalTeamId = 'team_design'
const uoaPrivateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(uoaPrivateKeyPem).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, uoaEnv)
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

type TeamRow = {
  id: string
  organizationId: string
  externalOrgId: string | null
  externalTeamId: string | null
}

const teams: TeamRow[] = [
  { id: teamId, organizationId, externalOrgId, externalTeamId: externalTeamId },
  // Never provisioned from a UOA team — a purely local team.
  { id: localTeamId, organizationId, externalOrgId: null, externalTeamId: null },
]

const makePrisma = (): PrismaClient =>
  ({
    // The roster response attaches each person's local principal id, resolved
    // org-scoped. Nobody in this fixture has ever signed in locally, so the
    // lookup finds nothing and every row keeps only its UOA subject — which is
    // exactly the shape these assertions expect.
    user: {
      findMany: async () => [],
    },
    team: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; project: { organizationId: string } }
      }) => {
        const team = teams.find(
          (candidate) =>
            candidate.id === where.id
            && candidate.organizationId === where.project.organizationId,
        )
        return team
          ? {
            externalOrgId: team.externalOrgId,
            externalTeamId: team.externalTeamId,
          }
          : null
      },
    },
  }) as unknown as PrismaClient

const actorContextFor = (
  roles: string[],
  overrides: { teamId?: string } = {},
): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles },
  tenant: {
    organizationId,
    projectId,
    teamId: overrides.teamId ?? teamId,
  },
  actionContext: {
    requestId: 'req-team-members',
    uoaIdentity: {
      organizationId: externalOrgId,
      subject: 'usr_ada',
      teamId: externalTeamId,
      tokenVersion: 7,
    },
  },
})

type StubCall = {
  url: string
  method: string
  authorization?: string
  hasAccessToken: boolean
  subjectAssertion?: string
  body?: string
}

type Responder = (call: StubCall) => Response

const stubFetch = (calls: StubCall[], respond: Responder): PinnedFetch =>
  (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    const call: StubCall = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      // UOA reads a present-but-blank access token as a malformed credential,
      // so the signed-subject path keeps it absent in every form.
      hasAccessToken: headers.has('x-uoa-access-token'),
      subjectAssertion: headers.get('x-uoa-subject-assertion') ?? undefined,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    }
    calls.push(call)
    return respond(call)
  }) as PinnedFetch

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const rosterDeps = (calls: StubCall[], respond: Responder) => ({
  fetchImpl: stubFetch(calls, respond),
  // The egress is IP-pinned; stub DNS so the pinned transport still runs.
  resolveHost: async () => ['93.184.216.34'],
})

const forbidUpstream = (message: string) => ({
  fetchImpl: (async () => {
    assert.fail(message)
  }) as unknown as PinnedFetch,
  resolveHost: async () => ['93.184.216.34'],
})

const makeApp = async (
  actorContext: AuthorizedActionContext,
  deps: Parameters<typeof registerTeamMembersRoutes>[2],
) => {
  const app = Fastify({ logger: false })
  registerTeamMembersRoutes(
    app,
    {
      prisma: makePrisma(),
      requireActorContext: () => actorContext,
    } as unknown as Parameters<typeof registerTeamMembersRoutes>[1],
    deps,
  )
  return app
}

const teamDetail = {
  id: externalTeamId,
  name: 'Design',
  members: [
    { userId: 'usr_ada', teamRole: 'owner' },
    { userId: 'usr_grace', teamRole: 'member' },
    // A row with no subject is not a member — it must not become one.
    { teamRole: 'member' },
  ],
}

const orgMembers = {
  data: [
    { userId: 'usr_ada', email: 'ada@acme.test', name: 'Ada Lovelace', role: 'owner', status: 'ACTIVE' },
    {
      userId: 'usr_grace',
      email: 'grace@acme.test',
      name: 'Grace Hopper',
      role: 'member',
      status: 'DEACTIVATED',
    },
  ],
  next_cursor: null,
}

test('the config JWT opts this domain into UOA backend org management', async () => {
  await withUoaEnv(async () => {
    const privateKeyPem = String(
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }),
    )
    const claims = JSON.parse(
      Buffer.from(
        buildConfigJwt({ ...loadUoaSettings(), privateKeyPem }).split('.')[1] ?? '',
        'base64url',
      ).toString('utf8'),
    ) as { org_features?: Record<string, unknown> }

    // Without this flag UOA answers 401 MISSING_ACCESS_TOKEN to every
    // backend-mode call, and Nessie holds no spendable user access token.
    assert.equal(claims.org_features?.backend_org_management, true)
  })
})

test('resolveUoaRosterTeam maps the session team to its UOA org + team', async () => {
  await withUoaEnv(async () => {
    const prisma = makePrisma()

    assert.deepEqual(
      await resolveUoaRosterTeam(prisma, { organizationId, teamId }),
      { externalOrgId, externalTeamId },
    )
    // No UOA mapping, no team in context, and another organisation's team all
    // resolve to nothing — there is never a fall back to local rows.
    assert.equal(
      await resolveUoaRosterTeam(prisma, { organizationId, teamId: localTeamId }),
      null,
    )
    assert.equal(await resolveUoaRosterTeam(prisma, { organizationId, teamId: null }), null)
    assert.equal(
      await resolveUoaRosterTeam(prisma, { organizationId: otherOrganizationId, teamId }),
      null,
    )
  })
})

test('GET /api/team/members joins the UOA team and organisation reads', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['member']),
      rosterDeps(calls, (call) =>
        json(call.url.includes('/teams/') ? teamDetail : orgMembers)),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })

      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data.members, [
        {
          uoaSub: 'usr_ada',
          displayName: 'Ada Lovelace',
          email: 'ada@acme.test',
          orgRole: 'owner',
          status: 'ACTIVE',
          teamRole: 'owner',
        },
        {
          uoaSub: 'usr_grace',
          displayName: 'Grace Hopper',
          email: 'grace@acme.test',
          orgRole: 'member',
          status: 'DEACTIVATED',
          teamRole: 'member',
        },
      ])

      const urls = calls.map((call) => call.url).sort()
      assert.deepEqual(urls, [
        `https://uoa.test/org/organisations/${externalOrgId}/members`
        + `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}&status=all`,
        `https://uoa.test/org/organisations/${externalOrgId}/teams/${externalTeamId}`
        + `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`,
      ])
      for (const call of calls) {
        assert.match(call.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
        assert.equal(call.hasAccessToken, false, 'UOA access tokens are never persisted or forwarded')
        assert.ok(call.subjectAssertion, 'the current UOA subject must be asserted upstream')
        const claims = JSON.parse(
          Buffer.from(call.subjectAssertion!.split('.')[1]!, 'base64url').toString('utf8'),
        ) as Record<string, unknown>
        assert.deepEqual(
          {
            active: claims.active,
            aud: claims.aud,
            source_domain: claims.source_domain,
            sub: claims.sub,
            tv: claims.tv,
          },
          {
            active: { orgId: externalOrgId, teamId: externalTeamId },
            aud: 'https://uoa.test/org',
            source_domain: 'nessie.test',
            sub: 'usr_ada',
            tv: 7,
          },
        )
      }
    } finally {
      await app.close()
    }
  })
})

test('the roster tolerates an unusable upstream shape without inventing members', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => json({ members: 'everyone', data: { nope: true } })),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data.members, [])
    } finally {
      await app.close()
    }
  })
})

test('a body that is not JSON is an outage, not an empty roster', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => new Response('<html>gateway</html>', { status: 200 })),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')
    } finally {
      await app.close()
    }
  })
})

test('an upstream 5xx is reported as a directory outage', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => new Response('boom', { status: 503 })),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')
    } finally {
      await app.close()
    }
  })
})

test('an upstream refusal surfaces as a client error, not an outage', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, (call) =>
        json({ error: 'refused' }, call.method === 'DELETE' ? 404 : 409)),
    )

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/team/members/usr_ghost',
      })
      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'TEAM_MEMBERS_REJECTED')

      const rejected = await app.inject({
        method: 'PUT',
        url: '/api/team/members/usr_ada/role',
        payload: { role: 'admin' },
      })
      assert.equal(rejected.statusCode, 400)
      assert.equal(rejected.json().error.code, 'TEAM_MEMBERS_REJECTED')
    } finally {
      await app.close()
    }
  })
})

test('a team with no UOA team 404s and never reaches UOA', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(
      actorContextFor(['owner'], { teamId: localTeamId }),
      forbidUpstream('an unlinked team must not reach the UOA org API'),
    )

    try {
      for (const request of [
        { method: 'GET' as const, url: '/api/team/members' },
        { method: 'GET' as const, url: '/api/team/invitations' },
        { method: 'DELETE' as const, url: '/api/team/members/usr_ada' },
        { method: 'POST' as const, url: '/api/team/invitations/inv_1/revoke' },
      ]) {
        const response = await app.inject(request)
        assert.equal(response.statusCode, 404, request.url)
        assert.equal(response.json().error.code, 'TEAM_NOT_LINKED')
      }
    } finally {
      await app.close()
    }
  })
})

test('the roster read is open to any member of the team', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['viewer']),
      rosterDeps(calls, (call) =>
        json(call.url.includes('/teams/') ? teamDetail : orgMembers)),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().data.members.length, 2)
    } finally {
      await app.close()
    }
  })
})

test('every mutation and the invitation list refuse a non-admin before any relay', async () => {
  for (const role of ['member', 'viewer']) {
    await withUoaEnv(async () => {
      const app = await makeApp(
        actorContextFor([role]),
        forbidUpstream(`a ${role} must never reach the full-trust domain-hash relay`),
      )

      const requests = [
        { method: 'GET' as const, url: '/api/team/invitations' },
        {
          method: 'POST' as const,
          url: '/api/team/invitations',
          payload: { invites: [{ email: 'new@acme.test' }] },
        },
        // Authorization is decided before the body is read, so a non-admin
        // learns "no", never "your payload is malformed".
        {
          method: 'POST' as const,
          url: '/api/team/invitations',
          payload: { invites: [{ email: 'not-an-email' }] },
        },
        { method: 'POST' as const, url: '/api/team/invitations/inv_1/resend' },
        { method: 'POST' as const, url: '/api/team/invitations/inv_1/revoke' },
        { method: 'POST' as const, url: '/api/team/invitations/inv_1/approve' },
        { method: 'POST' as const, url: '/api/team/invitations/inv_1/deny' },
        {
          method: 'PUT' as const,
          url: '/api/team/members/usr_ada/role',
          payload: { role: 'admin' },
        },
        { method: 'DELETE' as const, url: '/api/team/members/usr_ada' },
        { method: 'POST' as const, url: '/api/team/members/usr_ada/deactivate' },
        { method: 'POST' as const, url: '/api/team/members/usr_ada/reactivate' },
      ]

      try {
        for (const request of requests) {
          const response = await app.inject(request)
          assert.equal(response.statusCode, 403, `${role} ${request.method} ${request.url}`)
          assert.equal(response.json().error.code, 'FORBIDDEN')
        }
      } finally {
        await app.close()
      }
    })
  }
})

test('owners and admins drive the member and invitation mutations', async () => {
  for (const role of ['owner', 'admin']) {
    await withUoaEnv(async () => {
      const calls: StubCall[] = []
      const app = await makeApp(
        actorContextFor([role]),
        rosterDeps(calls, (call) => {
          if (call.method === 'GET') {
            return json({ data: [{ inviteId: 'inv_1', email: 'new@acme.test', status: 'pending' }] })
          }
          // UOA's revoke answers the agreed `{ ok: true }`; the member DELETE
          // ignores its body, so one shape serves both.
          if (call.method === 'DELETE') return json({ ok: true })
          return json({ results: [{ email: 'new@acme.test', status: 'invited' }] })
        }),
      )

      const base = `https://uoa.test/org/organisations/${externalOrgId}`
      const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`
      const expected: {
        request: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }
        upstream: { method: string; url: string; body?: string }
      }[] = [
        {
          request: { method: 'GET', url: '/api/team/invitations' },
          upstream: { method: 'GET', url: `${base}/teams/${externalTeamId}/invitations${query}` },
        },
        {
          request: {
            method: 'POST',
            url: '/api/team/invitations',
            payload: { invites: [{ email: ' new@acme.test ', teamRole: 'member' }] },
          },
          upstream: {
            method: 'POST',
            url: `${base}/teams/${externalTeamId}/invitations${query}`,
            body: JSON.stringify({
              invites: [{ email: 'new@acme.test', teamRole: 'member' }],
            }),
          },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/resend' },
          upstream: {
            method: 'POST',
            url: `${base}/teams/${externalTeamId}/invitations/inv_1/resend${query}`,
          },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/revoke' },
          upstream: {
            method: 'DELETE',
            url: `${base}/teams/${externalTeamId}/invitations/inv_1${query}`,
          },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/approve' },
          upstream: { method: 'POST', url: `${base}/invitations/inv_1/approve${query}` },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/deny' },
          upstream: { method: 'POST', url: `${base}/invitations/inv_1/deny${query}` },
        },
        {
          request: {
            method: 'PUT',
            url: '/api/team/members/usr_ada/role',
            payload: { role: 'admin' },
          },
          upstream: {
            method: 'PUT',
            url: `${base}/teams/${externalTeamId}/members/usr_ada${query}`,
            body: JSON.stringify({ team_role: 'admin' }),
          },
        },
        {
          request: { method: 'DELETE', url: '/api/team/members/usr_ada' },
          upstream: {
            method: 'DELETE',
            url: `${base}/teams/${externalTeamId}/members/usr_ada${query}`,
          },
        },
        {
          request: { method: 'POST', url: '/api/team/members/usr_ada/deactivate' },
          upstream: { method: 'POST', url: `${base}/members/usr_ada/deactivate${query}` },
        },
        {
          request: { method: 'POST', url: '/api/team/members/usr_ada/reactivate' },
          upstream: { method: 'POST', url: `${base}/members/usr_ada/reactivate${query}` },
        },
      ]

      try {
        for (const [index, step] of expected.entries()) {
          const response = await app.inject(step.request)
          assert.equal(response.statusCode, 200, `${role} ${step.request.url}`)
          const call = calls[index]
          assert.equal(call?.method, step.upstream.method, step.request.url)
          assert.equal(call?.url, step.upstream.url, step.request.url)
          assert.equal(call?.hasAccessToken, false)
          if (step.upstream.body !== undefined) {
            assert.equal(call?.body, step.upstream.body, step.request.url)
          }
        }
        assert.deepEqual(calls.length, expected.length)
        assert.deepEqual(
          (await app.inject(expected[1].request)).json().data.results,
          [{ email: 'new@acme.test', status: 'invited' }],
        )
      } finally {
        await app.close()
      }
    })
  }
})

test('revoking an accepted invitation answers 409, not the generic refusal', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['admin']),
      rosterDeps(calls, () => json({ error: 'invitation_already_accepted' }, 409)),
    )

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/team/invitations/inv_taken/revoke',
      })
      // "Too late, they are a member now" is a different answer from "no such
      // invitation", and the person is told which one it is.
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().error.code, 'INVITATION_ALREADY_ACCEPTED')

      // Every other relay keeps mapping a 409 to the generic client error.
      const generic = await app.inject({
        method: 'POST',
        url: '/api/team/invitations/inv_1/resend',
      })
      assert.equal(generic.statusCode, 400)
      assert.equal(generic.json().error.code, 'TEAM_MEMBERS_REJECTED')
    } finally {
      await app.close()
    }
  })
})

test('an invitation request with no usable email is refused before any relay', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(
      actorContextFor(['owner']),
      forbidUpstream('an invalid invitation must not reach UOA'),
    )

    try {
      for (const payload of [{ invites: [] }, { invites: [{ email: 'not-an-email' }] }, {}]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/team/invitations',
          payload,
        })
        assert.equal(response.statusCode, 400)
        assert.equal(response.json().error.code, 'VALIDATION_ERROR')
      }

      const badRole = await app.inject({
        method: 'PUT',
        url: '/api/team/members/usr_ada/role',
        payload: { role: 'owner' },
      })
      assert.equal(badRole.statusCode, 400)
    } finally {
      await app.close()
    }
  })
})

test('team member routes are inert when UOA is not configured', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  const app = await makeApp(
    actorContextFor(['owner']),
    forbidUpstream('an unconfigured deployment must not call UOA'),
  )

  try {
    const response = await app.inject({ method: 'GET', url: '/api/team/members' })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'TEAM_NOT_LINKED')
  } finally {
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
    await app.close()
  }
})
