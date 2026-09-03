import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { issueSessionToken } from '../src/auth/session.js'
import { registerTeamInvitationAcceptanceRoute } from '../src/routes/team-invitations.js'

const AUTH_SECRET = 'team-invite-route-secret'
const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'

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
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

const actorContext: AuthorizedActionContext = {
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
  actionContext: { requestId: 'team-invite-accept' },
}

const sessionToken = (providerType: 'oidc' | 'uoa'): string => issueSessionToken({
  org: organizationId,
  proj: projectId,
  providerId: providerType,
  providerType,
  roles: ['member'],
  sub: userId,
  team: teamId,
  ...(providerType === 'uoa' ? {
    uoaIdentity: {
      organizationId: 'uoa-current-org',
      subject: 'uoa-subject',
      teamId: 'uoa-current-team',
      tokenVersion: 4,
    },
  } : {}),
}, AUTH_SECRET, 300).token

type UpstreamCall = {
  body?: string
  hasAccessToken: boolean
  method: string
  url: string
}

const makeApp = async (input: {
  providerType: 'oidc' | 'uoa'
  respond: () => Response
  uoaSub: string | null
}) => {
  const calls: UpstreamCall[] = []
  const deleted: unknown[] = []
  const token = sessionToken(input.providerType)
  const prisma = {
    user: {
      findUnique: async () => ({ uoaSub: input.uoaSub }),
    },
    userAlert: {
      deleteMany: async (args: unknown) => {
        deleted.push(args)
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  const fetchImpl = (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      body: typeof init?.body === 'string' ? init.body : undefined,
      hasAccessToken: headers.has('x-uoa-access-token'),
      method: init?.method ?? 'GET',
      url: url.toString(),
    })
    return input.respond()
  }) as PinnedFetch
  const app = Fastify({ logger: false })
  registerTeamInvitationAcceptanceRoute(app, {
    authSecret: AUTH_SECRET,
    getAuthorizationToken: () => token,
    prisma,
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerTeamInvitationAcceptanceRoute>[1], {
    fetchImpl,
    resolveHost: async () => ['93.184.216.34'],
  })
  return { app, calls, deleted }
}

const request = {
  method: 'POST' as const,
  payload: { organizationId: 'uoa-invited-org', teamId: 'uoa-invited-team' },
  url: '/api/team/invitations/invite-1/accept',
}

test('acceptance refuses non-UOA sessions and users with no durable subject', async () => {
  await withUoaEnv(async () => {
    for (const input of [
      { providerType: 'oidc' as const, uoaSub: 'uoa-subject' },
      { providerType: 'uoa' as const, uoaSub: null },
    ]) {
      const { app, calls } = await makeApp({
        ...input,
        respond: () => {
          assert.fail('a refused caller must not reach UOA')
        },
      })
      try {
        const response = await app.inject(request)
        assert.equal(response.statusCode, 403)
        assert.equal(response.json().error.code, 'UOA_SESSION_REQUIRED')
        assert.equal(calls.length, 0)
      } finally {
        await app.close()
      }
    }
  })
})

test('ORG_CONFLICT_ON_DOMAIN becomes the named invitation conflict', async () => {
  await withUoaEnv(async () => {
    const { app } = await makeApp({
      providerType: 'uoa',
      respond: () => new Response(JSON.stringify({ code: 'ORG_CONFLICT_ON_DOMAIN' }), {
        status: 400,
      }),
      uoaSub: 'uoa-subject',
    })
    try {
      const response = await app.inject(request)
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().error.code, 'INVITATION_ORG_CONFLICT')
      assert.match(response.json().error.message, /already belong to another organisation/)
    } finally {
      await app.close()
    }
  })
})

test('successful acceptance uses backend mode and deletes the matching alert', async () => {
  await withUoaEnv(async () => {
    const { app, calls, deleted } = await makeApp({
      providerType: 'uoa',
      respond: () => new Response(JSON.stringify({
        ok: true,
        orgId: 'uoa-invited-org',
        teamId: 'uoa-invited-team',
      }), { status: 200 }),
      uoaSub: 'uoa-subject',
    })
    try {
      const response = await app.inject(request)
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data, {
        ok: true,
        organizationId: 'uoa-invited-org',
        teamId: 'uoa-invited-team',
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.method, 'POST')
      assert.equal(calls[0]?.hasAccessToken, false)
      assert.match(calls[0]?.url ?? '', /\/invitations\/invite-1\/accept\?/)
      assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { userId: 'uoa-subject' })
      assert.deepEqual(deleted, [{
        where: {
          eventKey: 'team-invite:invite-1',
          kind: 'team_invitation',
          userId,
        },
      }])
    } finally {
      await app.close()
    }
  })
})
