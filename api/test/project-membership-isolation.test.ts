import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { taskVisibilityWhere, type TaskVisibility } from '../src/services/tasks.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const memberId = '00000000-0000-4000-8000-000000000003'
const ownerId = '00000000-0000-4000-8000-000000000004'
const memberProjectId = '00000000-0000-4000-8000-000000000005'
const foreignProjectId = '00000000-0000-4000-8000-000000000006'
const outsideOrgProjectId = '00000000-0000-4000-8000-000000000007'

const actorCtx = (actorId: string, roles: string[] = []): AuthorizedActionContext =>
  ({
    actor: { actorType: 'user', actorId, roles },
    tenant: { organizationId },
  }) as unknown as AuthorizedActionContext

const projects = [
  { id: memberProjectId, organizationId },
  { id: foreignProjectId, organizationId },
  { id: outsideOrgProjectId, organizationId: otherOrganizationId },
]

// Only `memberId` belongs to `memberProjectId`.
const projectMembers = [{ projectId: memberProjectId, userId: memberId }]

const makePrisma = (): PrismaClient =>
  ({
    project: {
      count: async ({ where }: { where: Prisma.ProjectWhereInput }) =>
        projects.filter(
          (project) =>
            project.id === where.id && project.organizationId === where.organizationId,
        ).length,
    },
    projectMember: {
      count: async ({ where }: { where: Prisma.ProjectMemberWhereInput }) =>
        projectMembers.filter(
          (membership) =>
            membership.projectId === where.projectId && membership.userId === where.userId,
        ).length,
      findMany: async ({ where }: { where: Prisma.ProjectMemberWhereInput }) =>
        projectMembers
          .filter((membership) => membership.userId === where.userId)
          .filter((membership) => {
            const project = projects.find((entry) => entry.id === membership.projectId)
            return project?.organizationId === organizationId
          })
          .map((membership) => ({ projectId: membership.projectId })),
    },
  }) as unknown as PrismaClient

test('a non-member cannot reach a project they do not belong to', async () => {
  const helpers = createRequestHelpers(makePrisma())
  assert.equal(
    await helpers.isProjectAccessibleToActor(actorCtx(memberId), memberProjectId),
    true,
  )
  assert.equal(
    await helpers.isProjectAccessibleToActor(actorCtx(memberId), foreignProjectId),
    false,
  )
})

test('an owner reaches every project in their own organization only', async () => {
  const helpers = createRequestHelpers(makePrisma())
  assert.equal(
    await helpers.isProjectAccessibleToActor(actorCtx(ownerId, ['owner']), foreignProjectId),
    true,
  )
  // Cross-tenant stays closed even for an owner.
  assert.equal(
    await helpers.isProjectAccessibleToActor(actorCtx(ownerId, ['owner']), outsideOrgProjectId),
    false,
  )
})

test('accessible project ids are the memberships for a member, all for an owner', async () => {
  const helpers = createRequestHelpers(makePrisma())
  assert.deepEqual(await helpers.listAccessibleProjectIds(actorCtx(memberId)), [memberProjectId])
  assert.equal(await helpers.listAccessibleProjectIds(actorCtx(ownerId, ['owner'])), 'all')
})

// ─── Task visibility ────────────────────────────────────────────────────────

test('an owner gets no task filter at all', () => {
  assert.deepEqual(taskVisibilityWhere(undefined), {})
})

test('a member sees member-project, projectless, owned and assigned tasks', () => {
  const visibility: TaskVisibility = {
    accessibleProjectIds: [memberProjectId],
    actorUserId: memberId,
  }
  assert.deepEqual(taskVisibilityWhere(visibility), {
    OR: [
      { projectId: { in: [memberProjectId] } },
      { projectId: null },
      { ownerUserId: memberId },
      { assigneeUserId: memberId },
    ],
  })
})

test('a member with no project memberships still sees their own tasks', () => {
  const visibility: TaskVisibility = { accessibleProjectIds: [], actorUserId: memberId }
  const where = taskVisibilityWhere(visibility) as { OR: Array<Record<string, unknown>> }
  // An empty `in` list matches nothing, so another project's tasks stay hidden
  // while owned/assigned/projectless work is still reachable.
  assert.deepEqual(where.OR[0], { projectId: { in: [] } })
  assert.deepEqual(where.OR[2], { ownerUserId: memberId })
  assert.deepEqual(where.OR[3], { assigneeUserId: memberId })
})
