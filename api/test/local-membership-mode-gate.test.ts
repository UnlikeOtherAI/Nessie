import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * Org/project/team membership and roles belong to the identity provider outside
 * `local` mode (UOA SSO gap analysis, phase 4). The local rows are a projection
 * of the verified session claims, so a local write would be reverted at the
 * next login or token rotation — the server refuses it instead:
 *
 *   - `PATCH /api/users/:userId`                  (org role)
 *   - `POST  /api/users/:userId/deactivate`       (membership kill-switch)
 *   - `POST  /api/users/:userId/reactivate`
 *   - `POST  /api/teams/:teamId/members`
 *   - `POST  /api/projects/:projectId/members`
 *   - `DELETE /api/projects/:projectId/members/:userId`
 *
 * Each gate is also asserted *open* in local mode (the request reaches the next
 * step of the real handler), which is where the last-owner invariant still
 * applies. The gate sits after the owner check and before any body parse or
 * database read, matching the phase-1 gates in the same files.
 */

// --- @nessie/db stub: the route module graph imports it transitively --------
const dbStub = [
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is stubbed in local-membership-mode-gate.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used by local-membership-mode-gate.test.ts")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used by local-membership-mode-gate.test.ts")',
  '}',
  'export const writeAuditEntryInTransaction = async () => {}',
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
const { registerProjectRoutes } = await import('../src/routes/projects.js')
const { registerTeamRoutes } = await import('../src/routes/teams.js')
const { registerUserRoutes } = await import('../src/routes/users.js')

type Mode = 'local' | 'selfHosted' | 'hosted'

const NON_LOCAL_MODES: Mode[] = ['hosted', 'selfHosted']

const actorContext = {
  actor: { actorType: 'user', actorId: 'user-1', roles: ['owner'] },
  tenant: { organizationId: 'org-1', projectId: 'project-1', teamId: 'team-1' },
  actionContext: { requestId: 'req-membership-gate' },
}

/** Records whether a gated handler reached the database at all. */
class PrismaSpy {
  reads = 0

  private readonly count = async () => {
    this.reads += 1
    return 0
  }

  private readonly findNothing = async () => {
    this.reads += 1
    return null
  }

  readonly client = {
    organizationMember: { count: this.count, findUnique: this.findNothing },
    project: { findUnique: this.findNothing, findFirst: this.findNothing },
    projectMember: {
      create: this.findNothing,
      deleteMany: async () => {
        this.reads += 1
        return { count: 0 }
      },
    },
    team: { findUnique: this.findNothing },
    teamMember: { create: this.findNothing },
  }
}

const buildApp = async (mode: Mode, prismaSpy: PrismaSpy) => {
  const app = Fastify({ logger: false })
  const deps = {
    MEMBERSHIP_ROLES: ['owner', 'admin', 'member', 'viewer'],
    config: { mode },
    isProjectAccessibleToActor: () => true,
    listAccessibleProjectIds: async () => [],
    prisma: prismaSpy.client,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    resolveMembershipRole: (role?: string) =>
      (['owner', 'admin', 'member', 'viewer'].includes(role ?? '') ? role : null),
  } as never
  registerUserRoutes(app, deps)
  registerTeamRoutes(app, deps)
  registerProjectRoutes(app, deps)
  await app.ready()
  return app
}

type Call = {
  body?: unknown
  /** The error code the real handler answers with in local mode. */
  localCode: string
  localStatus: number
  method: 'PATCH' | 'POST' | 'DELETE'
  name: string
  url: string
}

// In local mode each call lands on the handler's own next step: an unknown role
// (INVALID_ROLE), a missing userId (USER_ID_REQUIRED), or a lookup that finds
// nothing in the spy (MEMBER_NOT_FOUND / NOT_FOUND). Reaching any of those
// proves the gate is open and that the handler really is behind it.
const CALLS: Call[] = [
  {
    body: { role: 'not-a-role' },
    localCode: 'INVALID_ROLE',
    localStatus: 400,
    method: 'PATCH',
    name: 'PATCH /api/users/:userId',
    url: '/api/users/user-2',
  },
  {
    localCode: 'MEMBER_NOT_FOUND',
    localStatus: 404,
    method: 'POST',
    name: 'POST /api/users/:userId/deactivate',
    url: '/api/users/user-2/deactivate',
  },
  {
    localCode: 'MEMBER_NOT_FOUND',
    localStatus: 404,
    method: 'POST',
    name: 'POST /api/users/:userId/reactivate',
    url: '/api/users/user-2/reactivate',
  },
  {
    body: {},
    localCode: 'USER_ID_REQUIRED',
    localStatus: 400,
    method: 'POST',
    name: 'POST /api/teams/:teamId/members',
    url: '/api/teams/team-1/members',
  },
  {
    body: {},
    localCode: 'USER_ID_REQUIRED',
    localStatus: 400,
    method: 'POST',
    name: 'POST /api/projects/:projectId/members',
    url: '/api/projects/project-1/members',
  },
  {
    localCode: 'NOT_FOUND',
    localStatus: 404,
    method: 'DELETE',
    name: 'DELETE /api/projects/:projectId/members/:userId',
    url: '/api/projects/project-1/members/user-2',
  },
]

const send = (
  app: Awaited<ReturnType<typeof buildApp>>,
  call: Call,
) =>
  app.inject({
    method: call.method,
    url: call.url,
    // A bodyless call must not declare a JSON content type, or Fastify answers
    // 400 before the route runs and the gate is never reached.
    ...(call.body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(call.body),
        }),
  })

for (const call of CALLS) {
  for (const mode of NON_LOCAL_MODES) {
    test(`${call.name} is refused in ${mode} mode without touching the database`, async () => {
      const prismaSpy = new PrismaSpy()
      const app = await buildApp(mode, prismaSpy)

      const response = await send(app, call)

      assert.equal(response.statusCode, 403)
      assert.equal(
        response.json().error.code,
        'LOCAL_MEMBERSHIP_MANAGEMENT_DISABLED',
      )
      assert.match(response.json().error.message, /identity provider/i)
      assert.equal(prismaSpy.reads, 0)

      await app.close()
    })
  }

  test(`${call.name} still runs in local mode`, async () => {
    const prismaSpy = new PrismaSpy()
    const app = await buildApp('local', prismaSpy)

    const response = await send(app, call)

    assert.equal(response.statusCode, call.localStatus)
    assert.equal(response.json().error.code, call.localCode)

    await app.close()
  })
}
