import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * `PATCH /api/auth/me/avatar` stores a local attachment that used to sit ON TOP
 * of the picture UnlikeOtherAI holds. UOA owns the profile of everyone who
 * signs in through it, so that route now refuses a UOA session outright
 * (`403 PROFILE_MANAGED_BY_SSO`) and those sessions change the photo at the
 * source through `PUT/DELETE /api/auth/me/avatar/uoa`. Deployments with no UOA
 * keep the local path exactly as it was.
 */

// --- @nessie/db stub: the route module graph imports it transitively --------
const dbStub = [
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is stubbed in profile-avatar-patch-gate.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
].join('\n')
const dbStubUrl = `data:text/javascript,${encodeURIComponent(dbStub)}`
const dbLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@nessie/db') {
    return { shortCircuit: true, url: ${JSON.stringify(dbStubUrl)} }
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(dbLoader)}`, import.meta.url)

const { default: Fastify } = await import('fastify')
const { registerAuthCoreRoutes } = await import('../src/routes/auth-core.js')

const userId = '00000000-0000-4000-8000-00000000000a'
const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const attachmentId = '00000000-0000-4000-8000-0000000000cc'

const userRow = {
  avatarAttachmentId: null,
  avatarUrl: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  displayName: 'Ada Lovelace',
  email: 'ada.lovelace@example.com',
  id: userId,
  passwordHash: null,
  preferences: null,
  pronouns: null,
  superAdmin: false,
  tokenVersion: 0,
  uoaSub: null,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const claimsFor = (providerType: 'local-bootstrap' | 'uoa') => ({
  exp: 1_700_086_400,
  iat: 1_700_000_000,
  org: organizationId,
  proj: projectId,
  providerId: providerType,
  providerType,
  roles: ['owner'],
  sid: 'session-1',
  sub: userId,
  team: teamId,
})

const makeApp = async (providerType: 'local-bootstrap' | 'uoa') => {
  const updates: Array<Record<string, unknown>> = []
  const claims = claimsFor(providerType)
  const prisma = {
    organizationMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
    productAccountLink: { findUnique: async () => null },
    team: { findMany: async () => [] },
    user: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        return { ...userRow, ...data }
      },
    },
  }
  const app = Fastify({ logger: false })
  registerAuthCoreRoutes(
    app,
    {
      authenticateRequest: async () => ({
        actorContext: {
          actor: { actorType: 'user', actorId: userId, roles: ['owner'] },
          tenant: { organizationId, projectId, teamId },
          actionContext: { requestId: 'req-avatar-gate' },
        },
        claims,
        me: { user: { preferences: {} } },
      }),
      config: { auth: { autoRedirectToSso: false, providers: [] }, mode: 'hosted' },
      getAuthorizationToken: () => 'token',
      prisma,
      resolveBootstrapState: async () => null,
    } as unknown as Parameters<typeof registerAuthCoreRoutes>[1],
    (async () => {}) as unknown as Parameters<typeof registerAuthCoreRoutes>[2],
  )
  return { app, updates }
}

test('a UOA session cannot store a local avatar that would override UOA', async () => {
  const { app, updates } = await makeApp('uoa')
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/avatar',
      payload: { avatarAttachmentId: attachmentId },
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'PROFILE_MANAGED_BY_SSO')
    // Refused before anything is written, and before the attachment lookup.
    assert.deepEqual(updates, [])
  } finally {
    await app.close()
  }
})

test('a UOA session cannot clear a local avatar through the local route either', async () => {
  const { app, updates } = await makeApp('uoa')
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/avatar',
      payload: { avatarAttachmentId: null },
    })

    assert.equal(response.statusCode, 403)
    assert.deepEqual(updates, [])
  } finally {
    await app.close()
  }
})

test('a non-UOA session keeps the local avatar path unchanged', async () => {
  const { app, updates } = await makeApp('local-bootstrap')
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me/avatar',
      payload: { avatarAttachmentId: null },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(updates, [{ avatarAttachmentId: null }])
  } finally {
    await app.close()
  }
})
