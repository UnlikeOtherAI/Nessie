import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { sendApiError } from '../src/lib/api.js'
import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { registerProjectRoutes } from '../src/routes/projects.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * Who may create and change a project, through the real `/api/projects` routes
 * and the real entitlement helpers, against a real database.
 *
 * The model (`docs/standards/team-model.md` → "Who may change a project or a
 * channel"): any organisation member creates a project; every member of it has
 * equal rights, whatever `ProjectMember.role` says; only an organisation owner
 * or admin reaches a project they are not a member of. Somebody else cannot
 * see the project, so a refusal is the read's own 404.
 *
 * `requireProjectModifier` is a closure inside `createServerContext`, which
 * needs a whole server to build; the three lines below restate its reply
 * mapping and delegate the decision to the real `canActorModifyProject`.
 */

const suite = 'e9a1'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const anchorProjectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`

const creatorUserId = `00000000-0000-4000-8000-${suite}00000010`
const peerUserId = `00000000-0000-4000-8000-${suite}00000011`
const outsiderUserId = `00000000-0000-4000-8000-${suite}00000012`
const orgAdminUserId = `00000000-0000-4000-8000-${suite}00000013`
const newcomerUserId = `00000000-0000-4000-8000-${suite}00000014`

const userIds = [creatorUserId, peerUserId, outsiderUserId, orgAdminUserId, newcomerUserId]
const roleOf = (userId: string) => (userId === orgAdminUserId ? 'admin' : 'member')

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: [roleOf(userId)] },
  tenant: { organizationId: parseOrganizationId(orgId), teamId: parseTeamId(teamId) },
  actionContext: { requestId: `req-project-rights-${userId}`, teamId: parseTeamId(teamId) },
})

const MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'viewer'] as const

const buildApp = async (prisma: PrismaClient) => {
  const helpers = createRequestHelpers(prisma)
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    const userId = request.headers['x-test-user']
    if (typeof userId === 'string') {
      ;(request as FastifyRequest & { actorContext?: AuthorizedActionContext }).actorContext =
        actorFor(userId)
    }
  })
  const deps = {
    prisma,
    MEMBERSHIP_ROLES,
    isProjectAccessibleToActor: helpers.isProjectAccessibleToActor,
    requireActorContext: (request: FastifyRequest, reply: FastifyReply) => {
      const context = (request as FastifyRequest & { actorContext?: AuthorizedActionContext })
        .actorContext
      if (context) return context
      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
      return null
    },
    requireProjectModifier: async (
      actorContext: AuthorizedActionContext,
      projectId: string,
      reply: FastifyReply,
    ) => {
      if (await helpers.canActorModifyProject(actorContext, projectId)) return true
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return false
    },
    resolveMembershipRole: (role: string | undefined) =>
      role === undefined
        ? 'member'
        : (MEMBERSHIP_ROLES as readonly string[]).includes(role) ? role : null,
  } as unknown as RouteDeps
  registerProjectRoutes(app, deps)
  await app.ready()
  return app
}

type App = Awaited<ReturnType<typeof buildApp>>

const call = (
  app: App,
  userId: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    headers: { 'x-test-user': userId },
    method,
    url,
    ...(payload ? { payload } : {}),
  })

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `project-rights-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Project rights ${index}`,
      email: `project-rights-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({ organizationId: orgId, role: roleOf(userId), userId })),
  })
  // The team every plain member stands in; the organisation admin is not in it.
  await prisma.project.create({
    data: { id: anchorProjectId, name: `anchor-${suite}`, organizationId: orgId },
  })
  await prisma.team.create({ data: { id: teamId, name: `team-${suite}`, projectId: anchorProjectId } })
  await prisma.teamMember.createMany({
    data: [creatorUserId, peerUserId, outsiderUserId, newcomerUserId].map((userId) => ({
      role: 'member',
      teamId,
      userId,
    })),
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } })
  const projects = await prisma.project.findMany({
    where: { organizationId: orgId, id: { not: anchorProjectId } },
    select: { id: true },
  })
  const projectIds = projects.map((project) => project.id)
  await prisma.projectMember.deleteMany({ where: { projectId: { in: [...projectIds, anchorProjectId] } } })
  await prisma.boardColumn.deleteMany({ where: { board: { projectId: { in: projectIds } } } })
  await prisma.board.deleteMany({ where: { projectId: { in: projectIds } } })
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.teamMember.deleteMany({ where: { teamId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: anchorProjectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const withApp = async (run: (app: App, prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  const app = await buildApp(prisma)
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(app, prisma)
  } finally {
    await app.close()
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

// A project made the way a person makes one, with a second member who holds the
// weakest project role there is.
const createProjectWithPeer = async (app: App, prisma: PrismaClient): Promise<string> => {
  const created = await call(app, creatorUserId, 'POST', '/api/projects', {
    name: `Rights ${suite}`,
    teamId,
  })
  assert.equal(created.statusCode, 201, created.body)
  const projectId = (created.json() as { data: { id: string } }).data.id
  await prisma.projectMember.create({ data: { projectId, role: 'viewer', userId: peerUserId } })
  return projectId
}

const isProjectMember = async (prisma: PrismaClient, projectId: string, userId: string) =>
  (await prisma.projectMember.count({ where: { projectId, userId } })) > 0

// ─── Rule 1 ─────────────────────────────────────────────────────────────────

dbTest('a plain organisation member creates a project and is its first member', async () => {
  await withApp(async (app, prisma) => {
    const created = await call(app, creatorUserId, 'POST', '/api/projects', {
      name: `Member made ${suite}`,
      teamId,
    })
    assert.equal(created.statusCode, 201, created.body)
    const projectId = (created.json() as { data: { id: string } }).data.id
    const members = await prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } })
    assert.deepEqual(members, [{ userId: creatorUserId }])
  })
})

// ─── Rule 2 ─────────────────────────────────────────────────────────────────

dbTest('any project member renames it, manages its members and deletes it', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)

    const renamed = await call(app, peerUserId, 'PATCH', `/api/projects/${projectId}`, {
      name: `Renamed by a viewer ${suite}`,
    })
    assert.equal(renamed.statusCode, 200, renamed.body)

    const added = await call(app, peerUserId, 'POST', `/api/projects/${projectId}/members`, {
      userId: newcomerUserId,
    })
    assert.equal(added.statusCode, 201, added.body)
    assert.equal(await isProjectMember(prisma, projectId, newcomerUserId), true)

    // The creator holds no privilege over the people they let in.
    const evicted = await call(
      app,
      newcomerUserId,
      'DELETE',
      `/api/projects/${projectId}/members/${creatorUserId}`,
    )
    assert.equal(evicted.statusCode, 200, evicted.body)
    assert.equal(await isProjectMember(prisma, projectId, creatorUserId), false)

    const deleted = await call(app, peerUserId, 'DELETE', `/api/projects/${projectId}`)
    assert.equal(deleted.statusCode, 200, deleted.body)
    assert.equal(await prisma.project.count({ where: { id: projectId } }), 0)
  })
})

// ─── Rule 3 ─────────────────────────────────────────────────────────────────

dbTest('a member outside the project can neither see nor change it', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)

    const responses = await Promise.all([
      call(app, outsiderUserId, 'GET', `/api/projects/${projectId}`),
      call(app, outsiderUserId, 'PATCH', `/api/projects/${projectId}`, { name: 'Hijacked' }),
      call(app, outsiderUserId, 'POST', `/api/projects/${projectId}/members`, { userId: outsiderUserId }),
      call(app, outsiderUserId, 'DELETE', `/api/projects/${projectId}/members/${peerUserId}`),
      call(app, outsiderUserId, 'DELETE', `/api/projects/${projectId}`),
    ])
    assert.deepEqual(responses.map((response) => response.statusCode), [404, 404, 404, 404, 404])

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    assert.equal(project.name, `Rights ${suite}`)
    assert.equal(await isProjectMember(prisma, projectId, outsiderUserId), false)
    assert.equal(await isProjectMember(prisma, projectId, peerUserId), true)

    const listed = await call(app, outsiderUserId, 'GET', '/api/projects')
    const ids = (listed.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)
    assert.equal(ids.includes(projectId), false)
  })
})

dbTest('an organisation admin outside the project sees it and changes it', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)

    const listed = await call(app, orgAdminUserId, 'GET', '/api/projects')
    const ids = (listed.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)
    assert.equal(ids.includes(projectId), true, 'an admin lists a project they are not in')
    assert.equal((await call(app, orgAdminUserId, 'GET', `/api/projects/${projectId}`)).statusCode, 200)

    const renamed = await call(app, orgAdminUserId, 'PATCH', `/api/projects/${projectId}`, {
      name: `Renamed by an admin ${suite}`,
    })
    assert.equal(renamed.statusCode, 200, renamed.body)

    const added = await call(app, orgAdminUserId, 'POST', `/api/projects/${projectId}/members`, {
      userId: newcomerUserId,
    })
    assert.equal(added.statusCode, 201, added.body)
    assert.equal(await isProjectMember(prisma, projectId, orgAdminUserId), false)
  })
})
