import assert from 'node:assert/strict'
import test from 'node:test'

import multipart from '@fastify/multipart'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerTeamAvatarRoutes } from '../src/routes/team-avatar.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const memberTeamId = '00000000-0000-4000-8000-000000000003'
const otherTeamId = '00000000-0000-4000-8000-000000000004'
const otherOrgTeamId = '00000000-0000-4000-8000-000000000005'
const userId = '00000000-0000-4000-8000-00000000000a'
const otherUserId = '00000000-0000-4000-8000-00000000000b'
const externalTeamId = 'uoa-team-42'
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId, teamId: memberTeamId },
  actionContext: { requestId: 'req-team-menu-avatar' },
}

const prisma = {
  team: {
    findFirst: async ({
      where,
    }: {
      where: {
        id: string
        project?: { organizationId: string }
        members?: { some: { userId: string } }
      }
    }) => {
      const rows = [
        {
          id: memberTeamId,
          members: [userId],
          externalTeamId: externalTeamId,
          name: 'Design',
        },
        {
          id: otherTeamId,
          members: [otherUserId],
          externalTeamId: 'uoa-team-other',
          name: 'Other',
        },
        {
          id: otherOrgTeamId,
          members: [userId],
          externalTeamId: 'uoa-team-other-org',
          name: 'Cross-org member',
        },
      ]
      const row = rows.find(
        (candidate) =>
          candidate.id === where.id &&
          (!where.project || where.project.organizationId === organizationId) &&
          (!where.members || candidate.members.includes(where.members.some.userId)),
      )
      return row
        ? { externalTeamId: row.externalTeamId, name: row.name }
        : null
    },
  },
} as unknown as PrismaClient

// A public IP literal, not a hostname: the relay goes through safeFetch, which
// resolves the host before dialling, and a literal is validated without DNS —
// so this route test (which stubs globalThis.fetch) reaches the stub instead of
// failing a lookup for a name that does not exist.
const UOA_TEST_BASE_URL = 'https://93.184.216.34'

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, {
    UOA_BASE_URL: UOA_TEST_BASE_URL,
    UOA_CLIENT_SECRET: 'test-client-secret',
    UOA_CONFIG_JWT_KID: 'test-kid',
    UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from('unused').toString('base64'),
    UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
    UOA_DOMAIN: 'nessie.test',
    UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
    UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
  })
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

test('team picker relays only team pictures the signed-in user may access', async () => {
  await withUoaEnv(async () => {
    const app = Fastify({ logger: false })
    await app.register(multipart)
    registerTeamAvatarRoutes(app, {
      prisma,
      requireActorContext: () => actorContext,
    } as unknown as Parameters<typeof registerTeamAvatarRoutes>[1])

    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      calls.push(String(input))
      return new Response(PNG_BYTES, {
        headers: { 'content-type': 'image/png', 'x-uoa-avatar-source': 'provider' },
      })
    }) as typeof fetch

    try {
      const memberResponse = await app.inject({
        method: 'GET',
        url: `/api/teams/${memberTeamId}/avatar`,
      })
      assert.equal(memberResponse.statusCode, 200)
      assert.equal(
        calls[0],
        `${UOA_TEST_BASE_URL}/domain/teams/${externalTeamId}/avatar?domain=nessie.test`,
      )

      const crossOrgMemberResponse = await app.inject({
        method: 'GET',
        url: `/api/teams/${otherOrgTeamId}/avatar`,
      })
      assert.equal(crossOrgMemberResponse.statusCode, 200)
      assert.equal(
        calls[1],
        `${UOA_TEST_BASE_URL}/domain/teams/uoa-team-other-org/avatar?domain=nessie.test`,
      )

      const nonMemberResponse = await app.inject({
        method: 'GET',
        url: `/api/teams/${otherTeamId}/avatar`,
      })
      assert.equal(nonMemberResponse.statusCode, 404)
      assert.equal(nonMemberResponse.json().error.code, 'AVATAR_NOT_FOUND')
      assert.equal(calls.length, 2)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
    }
  })
})
