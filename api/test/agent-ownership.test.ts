import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
  createAgentRecord,
  listAgentsForUser,
  isAgentVisibleToUser,
  resolveLocalUserIdsByUoaSub,
} from '@nessie/workspace-admin'

/**
 * Agent stewardship, exercised against a real database because every guarantee
 * here is a database guarantee: a composite foreign key, a CHECK constraint,
 * and predicates that join across membership. A stubbed client would assert the
 * shape of the query rather than that the constraint bites.
 *
 * Seed-scoped throughout: each row is created under ids unique to this suite and
 * removed in the same order, because these suites share one database and run
 * concurrently (AGENTS.md → Workflow).
 */

const suite = 'a9e0'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const otherOrgId = `00000000-0000-4000-8000-${suite}00000002`
const projectId = `00000000-0000-4000-8000-${suite}00000003`
const teamId = `00000000-0000-4000-8000-${suite}00000004`
const ownerUserId = `00000000-0000-4000-8000-${suite}00000005`
const strangerUserId = `00000000-0000-4000-8000-${suite}00000006`

const dbTest = process.env.DATABASE_URL ? test : test.skip

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.createMany({
    data: [
      { id: orgId, name: `steward-${suite}` },
      { id: otherOrgId, name: `steward-other-${suite}` },
    ],
    skipDuplicates: true,
  })
  await prisma.user.createMany({
    data: [
      { displayName: 'Owner', email: `owner-${suite}@test.local`, id: ownerUserId },
      { displayName: 'Stranger', email: `stranger-${suite}@test.local`, id: strangerUserId },
    ],
    skipDuplicates: true,
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgId, role: 'member', userId: ownerUserId },
      // A member of the OTHER organization only — the cross-tenant candidate.
      { organizationId: otherOrgId, role: 'member', userId: strangerUserId },
    ],
    skipDuplicates: true,
  })
  await prisma.project.createMany({
    data: [{ id: projectId, name: `p-${suite}`, organizationId: orgId }],
    skipDuplicates: true,
  })
  await prisma.team.createMany({
    data: [{ id: teamId, name: `t-${suite}`, projectId }],
    skipDuplicates: true,
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.agent.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({
    where: { userId: { in: [ownerUserId, strangerUserId] } },
  })
  await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, strangerUserId] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } })
}

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

dbTest('an unbound agent stays visible to the person who created it', async () => {
  await withDb(async (prisma) => {
    const agent = await createAgentRecord(prisma, {
      name: `steward-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
    })

    assert.equal(agent.ownerUserId, ownerUserId)
    assert.equal(agent.owner?.ownerState, 'active')
    assert.equal(agent.owner?.displayName, 'Owner')

    // `includeUnbound` is false: this is the ordinary member path, which before
    // stewardship could not see an agent that was not bound to a channel yet.
    const visible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.ok(
      visible.some((entry) => entry.id === agent.id),
      'a member should see the unbound agent they own',
    )
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, agent.id), true)
  })
})

dbTest('deactivating the owner withdraws the ownership-only visibility', async () => {
  await withDb(async (prisma) => {
    const agent = await createAgentRecord(prisma, {
      name: `steward-deact-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
    })

    await prisma.organizationMember.updateMany({
      data: { deactivatedAt: new Date() },
      where: { organizationId: orgId, userId: ownerUserId },
    })

    // The stored pointer is unchanged; only the live membership moved. If the
    // visibility branch trusted the pointer alone this would still be visible.
    const visible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.equal(
      visible.some((entry) => entry.id === agent.id),
      false,
      'a deactivated member must not keep ownership-derived visibility',
    )
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, agent.id), false)
  })
})

dbTest('a spawned subtask child never enters its owner\'s agent list', async () => {
  await withDb(async (prisma) => {
    const parent = await createAgentRecord(prisma, {
      name: `steward-parent-${suite}`,
      organizationId: orgId,
      ownerUserId,
      role: 'assistant',
    })

    // Exactly what `spawn_subtask` writes: a permanent row inheriting the
    // parent's owner, distinguished only by `parentAgentId`.
    const child = await prisma.agent.create({
      data: {
        name: `steward-child-${suite}`,
        organizationId: orgId,
        ownerUserId,
        parentAgentId: parent.id,
        role: 'researcher',
      },
      select: { id: true },
    })

    const visible = await listAgentsForUser(prisma, ownerUserId, orgId, false)
    assert.equal(
      visible.some((entry) => entry.id === child.id),
      false,
      'subtask children are run workers, not staff, and must stay out of the list',
    )
    assert.equal(await isAgentVisibleToUser(prisma, ownerUserId, orgId, child.id), false)
  })
})

dbTest('an owner from another organization is refused', async () => {
  await withDb(async (prisma) => {
    await assert.rejects(
      () =>
        createAgentRecord(prisma, {
          name: `steward-cross-${suite}`,
          organizationId: orgId,
          ownerUserId: strangerUserId,
          role: 'assistant',
        }),
      (error: unknown) =>
        error instanceof AgentManagementError
        && error.code === AGENT_MANAGEMENT_ERROR_CODES.OWNER_NOT_A_MEMBER,
      'a user with no membership in this organization cannot steward its agents',
    )
  })
})

dbTest('the database refuses cross-tenant stewardship even without the service check', async () => {
  await withDb(async (prisma) => {
    // Bypass the service entirely: the composite foreign key is the guarantee,
    // because one writer (spawn_subtask) creates agents outside the chokepoint.
    await assert.rejects(
      () =>
        prisma.agent.create({
          data: {
            name: `steward-raw-${suite}`,
            organizationId: orgId,
            ownerUserId: strangerUserId,
            role: 'assistant',
          },
        }),
      'the composite FK must reject an owner who is not a member of this org',
    )
  })
})

dbTest('uoaSub resolution is scoped to the calling organization', async () => {
  await withDb(async (prisma) => {
    const sub = `uoa-sub-${suite}`
    // The stranger belongs to the OTHER organization and carries the subject.
    await prisma.user.update({ data: { uoaSub: sub }, where: { id: strangerUserId } })

    const inCallerOrg = await resolveLocalUserIdsByUoaSub(prisma, orgId, [sub])
    assert.equal(
      inCallerOrg.get(sub),
      undefined,
      'a subject whose only membership is elsewhere must not resolve here',
    )

    const inOwnOrg = await resolveLocalUserIdsByUoaSub(prisma, otherOrgId, [sub])
    assert.equal(inOwnOrg.get(sub), strangerUserId)
  })
})
