import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { registerWorkspaceMembersRoutes } from '../src/routes/workspace-members.js'
import { clearWorkspaceRosterSubjectCache } from '../src/services/uoa-roster-subjects.js'

/**
 * The subject-keyed avatar relay. The interesting property is the gate in front
 * of it: UOA's `/domain/users/:sub/avatar` answers for every subject the domain
 * hash can see, so a subject outside this workspace's roster must be refused
 * *before* any avatar call is made — asserted from both sides here (the stub
 * fails the test if it is asked, and the recorded calls are checked after).
 */

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const localTeamId = '00000000-0000-4000-8000-000000000004'
const userId = '00000000-0000-4000-8000-00000000000a'
const externalOrgId = 'org_acme'
const externalTeamId = 'team_design'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from('unused').toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, uoaEnv)
  // The roster subject set is cached per workspace; each test drives its own
  // upstream stub, so none of them may inherit another's roster.
  clearWorkspaceRosterSubjectCache()
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
    clearWorkspaceRosterSubjectCache()
  }
}

type TeamRow = {
  id: string
  organizationId: string
  externalOrgId: string | null
  externalWorkspaceId: string | null
}

const teams: TeamRow[] = [
  { id: teamId, organizationId, externalOrgId, externalWorkspaceId: externalTeamId },
  { id: localTeamId, organizationId, externalOrgId: null, externalWorkspaceId: null },
]

const makePrisma = (): PrismaClient =>
  ({
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
          ? { externalOrgId: team.externalOrgId, externalWorkspaceId: team.externalWorkspaceId }
          : null
      },
    },
  }) as unknown as PrismaClient

const actorContextFor = (
  roles: string[],
  overrides: { teamId?: string } = {},
): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles },
  tenant: { organizationId, projectId, teamId: overrides.teamId ?? teamId },
  actionContext: { requestId: 'req-workspace-member-avatar' },
})

type StubCall = { url: string; method: string; authorization?: string }

const stubFetch = (
  calls: StubCall[],
  respond: (call: StubCall) => Response,
): PinnedFetch =>
  (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    const call: StubCall = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
    }
    calls.push(call)
    return respond(call)
  }) as PinnedFetch

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const relayDeps = (calls: StubCall[], respond: (call: StubCall) => Response) => ({
  fetchImpl: stubFetch(calls, respond),
  // Egress is IP-pinned; stub DNS so the pinned transport still runs.
  resolveHost: async () => ['93.184.216.34'],
})

const forbidUpstream = (message: string) => ({
  fetchImpl: (async () => {
    assert.fail(message)
  }) as unknown as PinnedFetch,
  resolveHost: async () => ['93.184.216.34'],
})

const teamDetail = {
  id: externalTeamId,
  name: 'Design',
  members: [
    { userId: 'usr_ada', teamRole: 'owner' },
    { userId: 'usr_grace', teamRole: 'member' },
  ],
}

const orgMembers = {
  data: [
    { userId: 'usr_ada', email: 'ada@acme.test', name: 'Ada Lovelace', role: 'owner' },
    { userId: 'usr_grace', email: 'grace@acme.test', name: 'Grace Hopper', role: 'member' },
  ],
}

const isAvatarCall = (call: StubCall): boolean => call.url.includes('/domain/users/')

const rosterResponse = (call: StubCall): Response =>
  json(call.url.includes('/teams/') ? teamDetail : orgMembers)

const makeApp = (
  actorContext: AuthorizedActionContext,
  deps: Parameters<typeof registerWorkspaceMembersRoutes>[2],
) => {
  const app = Fastify({ logger: false })
  registerWorkspaceMembersRoutes(
    app,
    {
      prisma: makePrisma(),
      requireActorContext: () => actorContext,
    } as unknown as Parameters<typeof registerWorkspaceMembersRoutes>[1],
    deps,
  )
  return app
}

const avatarUrl = (uoaSub: string): string =>
  `https://uoa.test/domain/users/${uoaSub}/avatar?domain=nessie.test`

test('a roster member’s avatar is relayed to any member of the workspace', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(
      actorContextFor(['member']),
      relayDeps(calls, (call) =>
        (isAvatarCall(call)
          ? new Response(PNG_BYTES, {
            headers: { 'content-type': 'image/png', 'x-uoa-avatar-source': 'uploaded' },
          })
          : rosterResponse(call))),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace/members/usr_grace/avatar',
      })

      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.rawPayload, PNG_BYTES)
      assert.equal(response.headers['content-type'], 'image/png')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
      assert.equal(response.headers['content-security-policy'], "default-src 'none'")
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
      assert.equal(response.headers['x-uoa-avatar-source'], 'uploaded')

      const avatarCalls = calls.filter(isAvatarCall)
      assert.equal(avatarCalls.length, 1)
      assert.equal(avatarCalls[0]?.url, avatarUrl('usr_grace'))
      assert.match(avatarCalls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
    } finally {
      await app.close()
    }
  })
})

test('a subject outside the roster is a 404 and never reaches the avatar endpoint', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(
      actorContextFor(['member']),
      relayDeps(calls, (call) => {
        // Side one: the relay must not be dialled at all for a foreign subject.
        if (isAvatarCall(call)) assert.fail(`a non-member subject reached ${call.url}`)
        return rosterResponse(call)
      }),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace/members/usr_outsider/avatar',
      })

      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'AVATAR_NOT_FOUND')
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
      // Side two: only the two roster reads were made.
      assert.deepEqual(calls.filter(isAvatarCall), [])
      assert.equal(calls.length, 2)
    } finally {
      await app.close()
    }
  })
})

test('the roster read behind the check is asked once per workspace, not once per row', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(
      actorContextFor(['member']),
      relayDeps(calls, (call) =>
        (isAvatarCall(call)
          ? new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
          : rosterResponse(call))),
    )

    try {
      const responses = await Promise.all(
        ['usr_ada', 'usr_grace'].map((uoaSub) =>
          app.inject({ method: 'GET', url: `/api/workspace/members/${uoaSub}/avatar` })),
      )

      for (const response of responses) assert.equal(response.statusCode, 200)
      assert.equal(calls.filter(isAvatarCall).length, 2)
      // Two roster calls total (team + organisation), shared by both rows.
      assert.equal(calls.filter((call) => !isAvatarCall(call)).length, 2)
    } finally {
      await app.close()
    }
  })
})

test('a team with no UOA workspace 404s the avatar without reaching UOA', async () => {
  await withUoaEnv(async () => {
    const app = makeApp(
      actorContextFor(['owner'], { teamId: localTeamId }),
      forbidUpstream('an unlinked team must not reach UOA'),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace/members/usr_ada/avatar',
      })

      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'WORKSPACE_NOT_LINKED')
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
    } finally {
      await app.close()
    }
  })
})

test('the member avatar route is inert when UOA is not configured', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  clearWorkspaceRosterSubjectCache()
  const app = makeApp(
    actorContextFor(['owner']),
    forbidUpstream('an unconfigured deployment must not call UOA'),
  )

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/members/usr_ada/avatar',
    })

    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'WORKSPACE_NOT_LINKED')
  } finally {
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
    clearWorkspaceRosterSubjectCache()
    await app.close()
  }
})

test('an avatar upstream failure is a 502, not a missing picture', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(
      actorContextFor(['member']),
      relayDeps(calls, (call) =>
        (isAvatarCall(call) ? new Response('boom', { status: 503 }) : rosterResponse(call))),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace/members/usr_ada/avatar',
      })

      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_AVATAR_UNAVAILABLE')
    } finally {
      await app.close()
    }
  })
})

test('an unreadable roster is a 502, never a silent "not a member"', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(
      actorContextFor(['member']),
      relayDeps(calls, (call) => {
        if (isAvatarCall(call)) assert.fail('an unreadable roster must not reach the avatar relay')
        return new Response('gateway', { status: 503 })
      }),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace/members/usr_ada/avatar',
      })

      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')

      // A failed roster read is not cached: the next request tries again.
      const retryCalls = calls.length
      await app.inject({ method: 'GET', url: '/api/workspace/members/usr_ada/avatar' })
      assert.ok(calls.length > retryCalls)
    } finally {
      await app.close()
    }
  })
})

test('a subject UOA has no picture for falls back to initials via a cacheable 404', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(
      actorContextFor(['member']),
      relayDeps(calls, (call) =>
        (isAvatarCall(call) ? new Response(null, { status: 404 }) : rosterResponse(call))),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/workspace/members/usr_ada/avatar',
      })

      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'AVATAR_NOT_FOUND')
      assert.equal(response.headers['cache-control'], 'private, max-age=300')
    } finally {
      await app.close()
    }
  })
})
