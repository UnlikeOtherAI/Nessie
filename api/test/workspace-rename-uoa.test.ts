import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { registerTeamRoutes } from '../src/routes/teams.js'

/**
 * Renaming a UOA-bound team is a write to UnlikeOtherAI, not to the local
 * mirror. This route used to answer `409 TEAM_NAME_OWNED_BY_IDP` and send
 * people to UOA's own admin, which left the product they were standing in
 * unable to rename the team they were looking at.
 */

const organizationId = '00000000-0000-4000-8000-0000000000e1'
const teamId = '00000000-0000-4000-8000-0000000000e2'
const userId = '00000000-0000-4000-8000-0000000000e3'
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

type UpstreamCall = { url: string; method: string; body?: string; subjectAssertion?: string }

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const makeApp = (options: {
  bound?: boolean
  respond?: (call: UpstreamCall) => Response
  withoutUoaIdentity?: boolean
}) => {
  const bound = options.bound ?? true
  const calls: UpstreamCall[] = []
  const teamUpdates: Array<Record<string, unknown>> = []
  const projectUpdates: Array<Record<string, unknown>> = []

  const prisma = {
    team: {
      findFirst: async () => ({
        externalOrgId: bound ? externalOrgId : null,
        externalTeamId: bound ? externalTeamId : null,
        id: teamId,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        teamUpdates.push(data)
        return { id: teamId, name: data.name }
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        teamUpdates.push(data)
        return { count: 1 }
      },
    },
    project: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        projectUpdates.push(data)
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerTeamRoutes(
    app,
    {
      config: { mode: 'local' },
      prisma,
      requireActorContext: () =>
        ({
          actionContext: {
            requestId: 'request-team-rename',
            ...(options.withoutUoaIdentity
              ? {}
              : {
                uoaIdentity: {
                  organizationId: externalOrgId,
                  subject: 'usr_ondra',
                  teamId: externalTeamId,
                  tokenVersion: 4,
                },
              }),
          },
          actor: { actorId: userId, actorType: 'user', roles: ['admin'] },
          tenant: { organizationId, teamId },
        }) as unknown as AuthorizedActionContext,
      requireOrgAdmin: () => true,
      requireOwner: () => true,
      resolveMembershipRole: () => 'member',
      MEMBERSHIP_ROLES: ['owner', 'admin', 'member'],
    } as unknown as Parameters<typeof registerTeamRoutes>[1],
    {
      fetchImpl: (async (url: URL, init) => {
        const headers = new Headers(init?.headers as HeadersInit)
        const call: UpstreamCall = {
          url: url.toString(),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
          ...(headers.get('x-uoa-subject-assertion')
            ? { subjectAssertion: headers.get('x-uoa-subject-assertion') as string }
            : {}),
        }
        calls.push(call)
        return (options.respond ?? (() => json({ id: externalTeamId, name: 'Design guild' })))(call)
      }) as PinnedFetch,
      // The egress is IP-pinned; stub DNS so the pinned transport still runs.
      resolveHost: async () => ['93.184.216.34'],
    },
  )
  return { app, calls, projectUpdates, teamUpdates }
}

const rename = (app: ReturnType<typeof makeApp>['app'], name = 'Design guild') =>
  app.inject({ method: 'PATCH', url: `/api/teams/${teamId}`, payload: { name } })

test('renaming a UOA-bound team writes to UnlikeOtherAI first', async () => {
  await withUoaEnv(async () => {
    const { app, calls, projectUpdates, teamUpdates } = makeApp({})
    const response = await rename(app)

    assert.equal(response.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'PUT')
    assert.match(
      calls[0]?.url ?? '',
      /\/org\/organisations\/org_acme\/teams\/team_design\?/,
    )
    assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { name: 'Design guild' })
    // UOA authorizes the person, not the tenant.
    assert.ok(calls[0]?.subjectAssertion)
    // The mirror is written from UOA's echoed record — and both rows that carry
    // the team label are healed, not just the Team.
    assert.deepEqual(teamUpdates, [{ name: 'Design guild' }])
    assert.deepEqual(projectUpdates, [{ name: 'Design guild' }])
    assert.deepEqual(response.json().data, { id: teamId, name: 'Design guild' })
  })
})

test('the mirror follows the name UOA stored, not the one that was asked for', async () => {
  await withUoaEnv(async () => {
    const { app, projectUpdates, teamUpdates } = makeApp({
      respond: () => json({ id: externalTeamId, name: 'Design Guild' }),
    })
    const response = await rename(app, '  Design guild  ')

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().data.name, 'Design Guild')
    assert.deepEqual(teamUpdates, [{ name: 'Design Guild' }])
    assert.deepEqual(projectUpdates, [{ name: 'Design Guild' }])
  })
})

test('a refusal from UnlikeOtherAI leaves the local name untouched', async () => {
  await withUoaEnv(async () => {
    const { app, calls, projectUpdates, teamUpdates } = makeApp({
      respond: () => json({ code: 'INSUFFICIENT_ORG_ROLE' }, 403),
    })
    const response = await rename(app)

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'TEAM_RENAME_REJECTED')
    assert.equal(calls.length, 1)
    assert.deepEqual(teamUpdates, [])
    assert.deepEqual(projectUpdates, [])
  })
})

test('an unreachable UnlikeOtherAI leaves the local name untouched', async () => {
  await withUoaEnv(async () => {
    const { app, projectUpdates, teamUpdates } = makeApp({
      respond: () => json({ error: 'boom' }, 503),
    })
    const response = await rename(app)

    assert.equal(response.statusCode, 502)
    assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')
    assert.deepEqual(teamUpdates, [])
    assert.deepEqual(projectUpdates, [])
  })
})

test('a session with no UOA identity cannot rename a UOA-bound team', async () => {
  await withUoaEnv(async () => {
    const { app, calls, projectUpdates, teamUpdates } = makeApp({ withoutUoaIdentity: true })
    const response = await rename(app)

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'UOA_SESSION_REQUIRED')
    assert.deepEqual(calls, [])
    assert.deepEqual(teamUpdates, [])
    assert.deepEqual(projectUpdates, [])
  })
})

test('a local-mode team still renames locally with no upstream call', async () => {
  await withUoaEnv(async () => {
    const { app, calls, projectUpdates, teamUpdates } = makeApp({ bound: false })
    const response = await rename(app, 'Design guild')

    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [])
    assert.deepEqual(teamUpdates, [{ name: 'Design guild' }])
    // Nothing UOA owns, so nothing to heal beside it.
    assert.deepEqual(projectUpdates, [])
  })
})
