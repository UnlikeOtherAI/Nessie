import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'

import { registerOrganizationRoutes } from '../src/routes/organizations.js'

/**
 * Renaming a UOA-bound organisation is a write to UnlikeOtherAI, not to the
 * local mirror. Nessie used to write `Organization.name` and stop: the new name
 * showed in Nessie alone — UOA's own team chooser and every other product
 * kept the old one — and the next login's directory sync reverted the row.
 */

const organizationId = '00000000-0000-4000-8000-0000000000d1'
const teamId = '00000000-0000-4000-8000-0000000000d2'
const userId = '00000000-0000-4000-8000-0000000000d3'
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
  externalOrgId: string | null
  orgRole?: string
  uoaContextResponse?: () => Response
  respond?: (call: UpstreamCall) => Response
  teamLinked?: boolean
  withoutUoaIdentity?: boolean
}) => {
  const calls: UpstreamCall[] = []
  const updates: Array<Record<string, unknown>> = []
  const organization = {
    conversationalSetupEnabled: false,
    externalOrgId: options.externalOrgId,
    id: organizationId,
    instanceBrand: false,
    logoAttachmentId: null,
    name: 'Ondra Rafaj',
    stripImageMetadata: true,
  }

  const prisma = {
    organization: {
      findUnique: async () => organization,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        return { ...organization, ...data }
      },
    },
    organizationMember: {
      findUnique: async () => ({ role: 'admin', deactivatedAt: null }),
    },
    team: {
      findFirst: async () =>
        options.teamLinked === false
          ? { externalOrgId: null, externalTeamId: null }
          : { externalOrgId, externalTeamId: externalTeamId },
    },
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerOrganizationRoutes(
    app,
    {
      prisma,
      fileService: {},
      requireActorContext: () =>
        ({
          actionContext: {
            requestId: 'request-organisation-rename',
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
      requireUserActor: () => true,
    } as unknown as Parameters<typeof registerOrganizationRoutes>[1],
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
        return new URL(call.url).pathname === '/org/me'
          ? (options.uoaContextResponse ?? (() =>
              json({ ok: true, org: { org_id: externalOrgId, org_role: options.orgRole ?? 'admin' } })))()
          : (options.respond ?? (() => json({ id: externalOrgId, name: 'UnlikeOtherAI' })))(call)
      }) as PinnedFetch,
      // The egress is IP-pinned; stub DNS so the pinned transport still runs.
      resolveHost: async () => ['93.184.216.34'],
    },
  )
  return { app, calls, updates }
}

const rename = (app: ReturnType<typeof makeApp>['app'], name = 'UnlikeOtherAI') =>
  app.inject({ method: 'PATCH', url: '/api/organizations/current', payload: { name } })

test('renaming a UOA-bound organisation writes to UnlikeOtherAI first', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({ externalOrgId })
    const response = await rename(app)

    assert.equal(response.statusCode, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.method, 'GET')
    assert.match(calls[0]?.url ?? '', /\/org\/me\?/)
    assert.equal(calls[1]?.method, 'PUT')
    assert.match(calls[1]?.url ?? '', /\/org\/organisations\/org_acme\?/)
    assert.deepEqual(JSON.parse(calls[1]?.body ?? '{}'), { name: 'UnlikeOtherAI' })
    // UOA authorizes the person, not the tenant: the call carries the signed
    // subject assertion, never a spendable access token.
    assert.ok(calls[1]?.subjectAssertion)
    // The mirror is written from UOA's echoed record, so the two agree by
    // construction rather than by both being told the same string.
    assert.deepEqual(updates, [{ name: 'UnlikeOtherAI' }])
    assert.equal(response.json().data.nameManagedExternally, true)
  })
})

test('a refusal from UnlikeOtherAI leaves the local name untouched', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({
      externalOrgId,
      respond: () => json({ code: 'INSUFFICIENT_ORG_ROLE' }, 403),
    })
    const response = await rename(app)

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'ORGANIZATION_RENAME_REJECTED')
    assert.equal(calls.length, 2)
    assert.deepEqual(updates, [])
  })
})

test('an unreachable UnlikeOtherAI leaves the local name untouched', async () => {
  await withUoaEnv(async () => {
    const { app, updates } = makeApp({
      externalOrgId,
      respond: () => json({ error: 'boom' }, 503),
    })
    const response = await rename(app)

    assert.equal(response.statusCode, 502)
    assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')
    assert.deepEqual(updates, [])
  })
})

test('a session with no UOA identity cannot rename a UOA-bound organisation', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({ externalOrgId, withoutUoaIdentity: true })
    const response = await rename(app)

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'ORGANIZATION_ADMIN_REQUIRED')
    assert.deepEqual(calls, [])
    assert.deepEqual(updates, [])
  })
})

test('a team with no UOA mapping cannot rename a UOA-bound organisation', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({ externalOrgId, teamLinked: false })
    const response = await rename(app)

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'UOA_SESSION_REQUIRED')
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /\/org\/me\?/)
    assert.deepEqual(updates, [])
  })
})

test('a local-mode organisation still renames locally with no upstream call', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({ externalOrgId: null })
    const response = await rename(app, 'Nessie Works')

    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [])
    assert.deepEqual(updates, [{ name: 'Nessie Works' }])
    assert.equal(response.json().data.nameManagedExternally, false)
  })
})

test('a UOA member cannot rename an organisation even if the local projection says admin', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({ externalOrgId, orgRole: 'member' })
    const response = await rename(app)

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'ORGANIZATION_ADMIN_REQUIRED')
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /\/org\/me\?/)
    assert.deepEqual(updates, [])
  })
})

test('the current-organisation response distinguishes UOA denial from an outage', async () => {
  await withUoaEnv(async () => {
    const forbidden = makeApp({ externalOrgId, orgRole: 'member' })
    const unavailable = makeApp({
      externalOrgId,
      uoaContextResponse: () => json({ error: 'unavailable' }, 503),
    })

    try {
      const forbiddenResponse = await forbidden.app.inject({ method: 'GET', url: '/api/organizations/current' })
      const unavailableResponse = await unavailable.app.inject({ method: 'GET', url: '/api/organizations/current' })

      assert.equal(forbiddenResponse.statusCode, 200)
      assert.equal(forbiddenResponse.json().data.administration.status, 'forbidden')
      assert.equal(unavailableResponse.statusCode, 200)
      assert.equal(unavailableResponse.json().data.administration.status, 'unavailable')
    } finally {
      await forbidden.app.close()
      await unavailable.app.close()
    }
  })
})

test('a PATCH that changes no name still checks UOA administration but does not relay a rename', async () => {
  await withUoaEnv(async () => {
    const { app, calls, updates } = makeApp({ externalOrgId })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/organizations/current',
      payload: { stripImageMetadata: false },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /\/org\/me\?/)
    assert.deepEqual(updates, [{ stripImageMetadata: false }])
  })
})
