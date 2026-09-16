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

// Binds the seeded organisation and team to UOA, as sign-in materialisation
// leaves them. `externalTeamId` makes `anchorProjectId` that team's anchor.
const bindToUoa = async (prisma: PrismaClient) => {
  await prisma.organization.update({ where: { id: orgId }, data: { externalOrgId: `uoa-org-${suite}` } })
  await prisma.team.update({ where: { id: teamId }, data: { externalTeamId: `uoa-team-${suite}` } })
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
    // A soft delete: the row stays for a future restore, and every read hides it.
    const kept = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    assert.notEqual(kept.deletedAt, null)
  })
})

// ─── Rule 3 ─────────────────────────────────────────────────────────────────

/**
 * Reading a project and changing it are now different entitlements, and this is
 * the test that holds them apart.
 *
 * A project is created `public`, so every organisation member may READ it —
 * the deliberate widening in the visibility spec. `canModifyProject` was NOT
 * widened with it: it is still membership, or an organisation owner/admin. If
 * the two are ever collapsed back together, the write assertions below fail
 * while the read ones still pass, which is exactly the signal wanted.
 */
dbTest('a member outside a public project may read it and may not change it', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)

    const read = await call(app, outsiderUserId, 'GET', `/api/projects/${projectId}`)
    assert.equal(read.statusCode, 200, read.body)
    const entry = (read.json() as { data: { access: string; visibility: string } }).data
    // `full`, not `limited`: public means browsable without joining, so there
    // is nothing to withhold from somebody who may already list it.
    assert.equal(entry.access, 'full')
    assert.equal(entry.visibility, 'public')

    const writes = await Promise.all([
      call(app, outsiderUserId, 'PATCH', `/api/projects/${projectId}`, { name: 'Hijacked' }),
      call(app, outsiderUserId, 'POST', `/api/projects/${projectId}/members`, { userId: outsiderUserId }),
      call(app, outsiderUserId, 'DELETE', `/api/projects/${projectId}/members/${peerUserId}`),
      call(app, outsiderUserId, 'DELETE', `/api/projects/${projectId}`),
    ])
    assert.deepEqual(writes.map((response) => response.statusCode), [404, 404, 404, 404])

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    assert.equal(project.name, `Rights ${suite}`)
    assert.equal(await isProjectMember(prisma, projectId, outsiderUserId), false)
    assert.equal(await isProjectMember(prisma, projectId, peerUserId), true)
  })
})

// The other half: closing the project takes it away from the same outsider
// entirely — not a 403, and not a listing they cannot open.
dbTest('a member outside a PROTECTED project can neither see nor change it', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)
    await prisma.project.update({ where: { id: projectId }, data: { visibility: 'protected' } })

    // Opening it by direct URL gives the simplified overview — protected is
    // discoverable, not invisible (decision 4) — while every write is refused
    // with the same 404 a missing project gives.
    const read = await call(app, outsiderUserId, 'GET', `/api/projects/${projectId}`)
    assert.equal(read.statusCode, 200, read.body)
    const overview = (read.json() as { data: Record<string, unknown> }).data
    assert.equal(overview.access, 'limited')
    assert.equal(overview.visibility, 'protected')
    assert.equal('project' in overview, false, 'the limited overview carries no record')

    const responses = await Promise.all([
      call(app, outsiderUserId, 'PATCH', `/api/projects/${projectId}`, { name: 'Hijacked' }),
      call(app, outsiderUserId, 'POST', `/api/projects/${projectId}/members`, { userId: outsiderUserId }),
      call(app, outsiderUserId, 'DELETE', `/api/projects/${projectId}/members/${peerUserId}`),
      call(app, outsiderUserId, 'DELETE', `/api/projects/${projectId}`),
    ])
    assert.deepEqual(responses.map((response) => response.statusCode), [404, 404, 404, 404])

    // It stays out of both browse listings, which is the other half of the rule.
    const listed = await call(app, outsiderUserId, 'GET', '/api/projects')
    const ids = (listed.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)
    assert.equal(ids.includes(projectId), false)

    const directory = await call(app, outsiderUserId, 'GET', '/api/projects/directory')
    const directoryIds = (directory.json() as { data: Array<{ id: string }> }).data
      .map((row) => row.id)
    assert.equal(directoryIds.includes(projectId), false)
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

// ─── Project membership is Nessie-owned ─────────────────────────────────────

dbTest('in a UOA-bound organisation a project member still manages its members', async () => {
  await withApp(async (app, prisma) => {
    await bindToUoa(prisma)
    const projectId = await createProjectWithPeer(app, prisma)

    const added = await call(app, peerUserId, 'POST', `/api/projects/${projectId}/members`, {
      userId: newcomerUserId,
    })
    assert.equal(added.statusCode, 201, added.body)
    assert.equal(await isProjectMember(prisma, projectId, newcomerUserId), true)

    const removed = await call(
      app,
      peerUserId,
      'DELETE',
      `/api/projects/${projectId}/members/${newcomerUserId}`,
    )
    assert.equal(removed.statusCode, 200, removed.body)
    assert.equal(await isProjectMember(prisma, projectId, newcomerUserId), false)
  })
})

dbTest('the anchor project of a UOA-bound team keeps its projected members read-only', async () => {
  await withApp(async (app, prisma) => {
    await bindToUoa(prisma)
    // Sign-in writes this row from the verified team membership.
    await prisma.projectMember.create({
      data: { projectId: anchorProjectId, role: 'member', userId: creatorUserId },
    })

    const added = await call(app, creatorUserId, 'POST', `/api/projects/${anchorProjectId}/members`, {
      userId: orgAdminUserId,
    })
    assert.equal(added.statusCode, 409, added.body)
    assert.equal(added.json().error.code, 'TEAM_PROJECT_MEMBERSHIP_MANAGED_BY_SSO')

    const removed = await call(
      app,
      creatorUserId,
      'DELETE',
      `/api/projects/${anchorProjectId}/members/${creatorUserId}`,
    )
    assert.equal(removed.statusCode, 409, removed.body)
    assert.equal(await isProjectMember(prisma, anchorProjectId, creatorUserId), true)
    assert.equal(await isProjectMember(prisma, anchorProjectId, orgAdminUserId), false)
  })
})

dbTest('a deactivated organisation member cannot be added to a project', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)
    await prisma.organizationMember.updateMany({
      where: { organizationId: orgId, userId: newcomerUserId },
      data: { deactivatedAt: new Date() },
    })
    const added = await call(app, peerUserId, 'POST', `/api/projects/${projectId}/members`, {
      userId: newcomerUserId,
    })
    assert.equal(added.statusCode, 404, added.body)
    assert.equal(await isProjectMember(prisma, projectId, newcomerUserId), false)
  })
})

// ─── Deleting is a soft delete ──────────────────────────────────────────────

dbTest('a deleted project is kept, with its channels, and hidden from every read', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)
    const channel = await prisma.channel.create({
      data: {
        label: `room-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `room-${suite}`,
        teamId,
        visibility: 'public',
        members: { create: [{ role: 'owner', userId: creatorUserId }] },
      },
    })

    const deleted = await call(app, creatorUserId, 'DELETE', `/api/projects/${projectId}`)
    assert.equal(deleted.statusCode, 200, deleted.body)

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    assert.notEqual(project.deletedAt, null)
    const room = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })
    assert.notEqual(room.deletedAt, null)
    assert.notEqual(room.archivedAt, null)
    assert.equal(await prisma.board.count({ where: { projectId } }) > 0, true, 'boards are kept')
    assert.equal(await isProjectMember(prisma, projectId, creatorUserId), true, 'members are kept')

    for (const userId of [creatorUserId, orgAdminUserId]) {
      const listed = await call(app, userId, 'GET', '/api/projects')
      const ids = (listed.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)
      assert.equal(ids.includes(projectId), false, userId)
      assert.equal((await call(app, userId, 'GET', `/api/projects/${projectId}`)).statusCode, 404)
      const directory = await call(app, userId, 'GET', '/api/projects/directory')
      const directoryIds = (directory.json() as { data: Array<{ id: string }> }).data.map((row) => row.id)
      assert.equal(directoryIds.includes(projectId), false, userId)
    }
    assert.equal(
      (await call(app, creatorUserId, 'PATCH', `/api/projects/${projectId}`, { name: 'Back again' })).statusCode,
      404,
    )
    assert.equal((await call(app, creatorUserId, 'DELETE', `/api/projects/${projectId}`)).statusCode, 404)
  })
})

// ─── What a person outside a project may see ────────────────────────────────

const WITHHELD_PROJECT_FIELDS = [
  'avatarAttachmentId',
  'avatarEmoji',
  'boards',
  'channelCount',
  'channels',
  'createdAt',
  'fields',
  'iterations',
  'memberCount',
  'organizationId',
  'project',
  'settings',
  'sources',
  'tasks',
  'teamCount',
  'viewerIsMember',
  'watchers',
]

dbTest('an outsider lists a project with only its name, description and members', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)
    const described = await call(app, creatorUserId, 'PATCH', `/api/projects/${projectId}`, {
      description: 'Where the launch gets planned',
    })
    assert.equal(described.statusCode, 200, described.body)

    const directory = await call(app, outsiderUserId, 'GET', '/api/projects/directory')
    assert.equal(directory.statusCode, 200, directory.body)
    const entry = (directory.json() as { data: Array<Record<string, unknown>> }).data
      .find((row) => row.id === projectId)
    assert.ok(entry, 'an outsider can find the project')
    // The whole key set, deliberately: a field added to the record without a
    // decision must fail here rather than reach an outsider. `visibility` is on
    // the list because the lock marker is derived from it client-side — the
    // wire carries no separate `locked` field.
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['access', 'description', 'id', 'members', 'name', 'visibility'],
    )
    assert.equal(entry.access, 'limited')
    assert.equal(entry.visibility, 'public')
    assert.equal(entry.description, 'Where the launch gets planned')
    for (const field of WITHHELD_PROJECT_FIELDS) {
      assert.equal(field in entry, false, `limited view carries no ${field}`)
    }
    const members = entry.members as Array<Record<string, unknown>>
    assert.deepEqual(
      members.map((member) => member.userId).sort(),
      [creatorUserId, peerUserId].sort(),
    )
    for (const member of members) {
      assert.deepEqual(Object.keys(member).sort(), ['avatarAttachmentId', 'avatarUrl', 'displayName', 'userId'])
    }

    // The single read gives the same outsider the `limited` arm rather than a
    // 404, because this project is public: they may know it exists and who is
    // in it. Closing it is what takes it away — covered above.
    const single = await call(app, outsiderUserId, 'GET', `/api/projects/${projectId}`)
    assert.equal(single.statusCode, 200, single.body)
    assert.equal((single.json() as { data: { access: string } }).data.access, 'full')
  })
})

dbTest('a member and an organisation admin get the full record in the directory', async () => {
  await withApp(async (app, prisma) => {
    const projectId = await createProjectWithPeer(app, prisma)
    for (const [userId, viewerIsMember] of [[peerUserId, true], [orgAdminUserId, false]] as const) {
      const directory = await call(app, userId, 'GET', '/api/projects/directory')
      const entry = (directory.json() as { data: Array<Record<string, unknown>> }).data
        .find((row) => row.id === projectId)
      assert.equal(entry?.access, 'full', userId)
      assert.equal(entry?.viewerIsMember, viewerIsMember, userId)
      assert.equal((entry?.project as { id: string }).id, projectId)
    }
  })
})
