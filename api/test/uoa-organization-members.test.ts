import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { registerOrganizationMembersRoutes } from '../src/routes/organization-members.js'

/**
 * `/api/organization/members` — the ORG-wide roster, resolved from the
 * session's organization (never through a Team row). Mirrors
 * `uoa-workspace-members.test.ts`'s harness: Fastify + an injected roster
 * egress seam, nothing reaches a live service.
 */

const organizationId = '00000000-0000-4000-8000-000000000001'
const teamId = '00000000-0000-4000-8000-000000000003'
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

const makePrisma = (): PrismaClient =>
  ({
    // The org roster resolves the UOA org from the ORGANIZATION row directly —
    // a fixture with no Team rows at all is the point: this route never joins
    // through a team the way the workspace roster does.
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === organizationId ? { externalOrgId } : null,
    },
    // Nobody in this fixture has ever signed in locally, so the local-principal
    // join finds nothing and every row keeps only its UOA subject.
    user: {
      findMany: async () => [],
    },
  }) as unknown as PrismaClient

const actorContextFor = (roles: string[]): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles },
  tenant: { organizationId, projectId: null, teamId },
  actionContext: {
    requestId: 'req-organization-members',
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
  hasAccessToken: boolean
  subjectAssertion?: string
  body?: string
}

type Responder = (call: StubCall) => Response

const stubFetch = (calls: StubCall[], respond: Responder): PinnedFetch =>
  (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      // UOA reads a present-but-blank access token as a malformed credential,
      // so the signed-subject path keeps it absent in every form.
      hasAccessToken: headers.has('x-uoa-access-token'),
      subjectAssertion: headers.get('x-uoa-subject-assertion') ?? undefined,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
    return respond(calls[calls.length - 1]!)
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
  deps: Parameters<typeof registerOrganizationMembersRoutes>[2],
) => {
  const app = Fastify({ logger: false })
  registerOrganizationMembersRoutes(
    app,
    {
      prisma: makePrisma(),
      requireActorContext: () => actorContext,
    } as unknown as Parameters<typeof registerOrganizationMembersRoutes>[1],
    deps,
  )
  return app
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

const base = `https://uoa.test/org/organisations/${externalOrgId}`
const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`

test('GET /api/organization/members returns the org-wide roster with org roles', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['member']),
      rosterDeps(calls, () => json(orgMembers)),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/organization/members' })

      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data.members, [
        {
          uoaSub: 'usr_ada',
          displayName: 'Ada Lovelace',
          email: 'ada@acme.test',
          orgRole: 'owner',
          status: 'ACTIVE',
        },
        {
          uoaSub: 'usr_grace',
          displayName: 'Grace Hopper',
          email: 'grace@acme.test',
          orgRole: 'member',
          status: 'DEACTIVATED',
        },
      ])

      // One upstream read, on the ORG members path — never a team path.
      assert.deepEqual(
        calls.map((call) => `${call.method} ${call.url}`),
        [`GET ${base}/members${query}&status=all`],
      )
      for (const call of calls) {
        assert.equal(call.hasAccessToken, false, 'UOA access tokens are never persisted or forwarded')
        assert.ok(call.subjectAssertion, 'the current UOA subject must be asserted upstream')
      }
    } finally {
      await app.close()
    }
  })
})

test('an organization with no UOA link 404s and never reaches UOA', async () => {
  await withUoaEnv(async () => {
    const app = Fastify({ logger: false })
    registerOrganizationMembersRoutes(
      app,
      {
        prisma: {
          organization: { findUnique: async () => ({ externalOrgId: null }) },
          user: { findMany: async () => [] },
        } as unknown as PrismaClient,
        requireActorContext: () => actorContextFor(['owner']),
      } as unknown as Parameters<typeof registerOrganizationMembersRoutes>[1],
      forbidUpstream('an unlinked organization must not reach the UOA org API'),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/organization/members' })
      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'ORGANIZATION_NOT_LINKED')
    } finally {
      await app.close()
    }
  })
})

test('the roster read is open to any member of the organization', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['viewer']),
      rosterDeps(calls, () => json(orgMembers)),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/organization/members' })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().data.members.length, 2)
    } finally {
      await app.close()
    }
  })
})

test('every mutation refuses a non-admin before any relay', async () => {
  for (const role of ['member', 'viewer']) {
    await withUoaEnv(async () => {
      const app = await makeApp(
        actorContextFor([role]),
        forbidUpstream(`a ${role} must never reach the full-trust domain-hash relay`),
      )

      const requests = [
        {
          method: 'PUT' as const,
          url: '/api/organization/members/usr_ada/role',
          payload: { role: 'admin' },
        },
        { method: 'POST' as const, url: '/api/organization/members/usr_ada/deactivate' },
        { method: 'POST' as const, url: '/api/organization/members/usr_ada/reactivate' },
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

test('owners and admins drive the org-role and activation mutations', async () => {
  for (const role of ['owner', 'admin']) {
    await withUoaEnv(async () => {
      const calls: StubCall[] = []
      const app = await makeApp(
        actorContextFor([role]),
        rosterDeps(calls, () => json({ ok: true })),
      )

      try {
        const roleResponse = await app.inject({
          method: 'PUT',
          url: '/api/organization/members/usr_grace/role',
          payload: { role: 'admin' },
        })
        assert.equal(roleResponse.statusCode, 200)

        const deactivateResponse = await app.inject({
          method: 'POST',
          url: '/api/organization/members/usr_grace/deactivate',
        })
        assert.equal(deactivateResponse.statusCode, 200)

        const reactivateResponse = await app.inject({
          method: 'POST',
          url: '/api/organization/members/usr_grace/reactivate',
        })
        assert.equal(reactivateResponse.statusCode, 200)

        assert.deepEqual(
          calls.map((call) => `${call.method} ${call.url} ${call.body ?? ''}`.trim()),
          [
            `PUT ${base}/members/usr_grace${query} {"role":"admin"}`,
            `POST ${base}/members/usr_grace/deactivate${query}`,
            `POST ${base}/members/usr_grace/reactivate${query}`,
          ],
        )
        // No `/teams/` in any path — org-scoped all the way down.
        for (const call of calls) assert.ok(!call.url.includes('/teams/'))
      } finally {
        await app.close()
      }
    })
  }
})

test('an upstream refusal surfaces as a client error, not an outage', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => json({ error: 'member_not_found' }, 404)),
    )

    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/organization/members/usr_ghost/role',
        payload: { role: 'admin' },
      })
      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'ORGANIZATION_MEMBERS_REJECTED')
    } finally {
      await app.close()
    }
  })
})
