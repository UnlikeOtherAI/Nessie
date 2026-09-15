import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createProjectForUser, deleteProject } from '../src/index.js'

/**
 * What deleting a project does.
 *
 * A delete is a soft delete: `Project.deletedAt` is stamped, the project's
 * channels are soft-deleted with it, and no row is removed. Three families
 * still refuse, because their data is reachable from surfaces that do not pass
 * through the project's own entitlement. Against a real database, because the
 * point is what survives in it.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  otherOrganizationId: string
  projectId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `project-delete-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `project-delete-${suffix}` },
  })
  const otherOrganization = await prisma.organization.create({
    data: { name: `project-delete-other-${suffix}` },
  })
  const anchorProject = await prisma.project.create({
    data: { name: `project-delete-anchor-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `project-delete-team-${suffix}`, projectId: anchorProject.id },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  await prisma.teamMember.create({
    data: { role: 'owner', teamId: team.id, userId: user.id },
  })
  const project = await createProjectForUser(prisma, {
    name: `Deletable ${suffix}`,
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
  })
  return {
    organizationId: organization.id,
    otherOrganizationId: otherOrganization.id,
    projectId: project.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, sown: Seed): Promise<void> => {
  // Executors hold the project with a Restrict FK, so they go before the org.
  await prisma.executor.deleteMany({ where: { organizationId: sown.organizationId } })
  await prisma.organization.deleteMany({
    where: { id: { in: [sown.organizationId, sown.otherOrganizationId] } },
  })
  await prisma.user.deleteMany({ where: { id: sown.userId } })
}

const withSeed = async (
  body: (prisma: PrismaClient, sown: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const sown = await seed(prisma)
  try {
    await body(prisma, sown)
  } finally {
    await cleanup(prisma, sown)
    await prisma.$disconnect()
  }
}

const addTeam = (prisma: PrismaClient, sown: Seed, externalTeamId?: string) =>
  prisma.team.create({
    data: {
      name: 'Team',
      projectId: sown.projectId,
      ...(externalTeamId ? { externalTeamId } : {}),
    },
  })

runDatabaseTest('a project is soft-deleted: kept, stamped, and not deleted twice', async () => {
  await withSeed(async (prisma, sown) => {
    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(result, { kind: 'deleted' })
    const kept = await prisma.project.findUniqueOrThrow({ where: { id: sown.projectId } })
    assert.notEqual(kept.deletedAt, null)
    assert.equal(await prisma.projectMember.count({ where: { projectId: sown.projectId } }), 1)
    assert.ok((await prisma.board.count({ where: { projectId: sown.projectId } })) > 0)

    const again = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(again, { kind: 'not_found' })
  })
})

runDatabaseTest('a project in another organisation is not found', async () => {
  await withSeed(async (prisma, sown) => {
    const result = await deleteProject(prisma, {
      organizationId: sown.otherOrganizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(result, { kind: 'not_found' })
    assert.equal(
      await prisma.project.count({ where: { id: sown.projectId } }),
      1,
    )
  })
})

runDatabaseTest('channels no longer refuse: they are soft-deleted with the project', async () => {
  await withSeed(async (prisma, sown) => {
    const team = await addTeam(prisma, sown)
    // Not `general`: the project already started with its own #general.
    const channel = await prisma.channel.create({
      data: {
        label: 'launch',
        slug: 'launch',
        organizationId: sown.organizationId,
        projectId: sown.projectId,
        teamId: team.id,
      },
    })
    await prisma.thread.create({ data: { channelId: channel.id, title: 'General' } })

    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(result, { kind: 'deleted' })
    const kept = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })
    assert.notEqual(kept.deletedAt, null)
    assert.notEqual(kept.archivedAt, null)
    assert.equal(await prisma.thread.count({ where: { channelId: channel.id } }), 1)
  })
})

runDatabaseTest('a knowledge space refuses the delete and survives it', async () => {
  await withSeed(async (prisma, sown) => {
    const space = await prisma.knowledgeSpace.create({
      data: {
        name: 'Handbook',
        createdBy: sown.userId,
        organizationId: sown.organizationId,
        projectId: sown.projectId,
      },
    })

    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.equal(result.kind, 'blocked')
    assert.deepEqual(
      result.kind === 'blocked' ? result.blocks.map((block) => block.code) : [],
      ['PROJECT_HAS_KNOWLEDGE'],
    )
    assert.equal(
      await prisma.knowledgeSpace.count({ where: { id: space.id } }),
      1,
    )
  })
})

runDatabaseTest('an executor refuses with a 409-shaped refusal, not a P2003 crash', async () => {
  await withSeed(async (prisma, sown) => {
    await prisma.executor.create({
      data: {
        label: 'Workstation',
        organizationId: sown.organizationId,
        pairingOwnerUserId: sown.userId,
        projectId: sown.projectId,
        scopeKind: 'project',
      },
    })

    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.equal(result.kind, 'blocked')
    assert.deepEqual(
      result.kind === 'blocked' ? result.blocks.map((block) => block.code) : [],
      ['PROJECT_HAS_EXECUTORS'],
    )
  })
})

runDatabaseTest('a UOA-bound team refuses; an unbound one does not', async () => {
  await withSeed(async (prisma, sown) => {
    const bound = await addTeam(prisma, sown, `uoa-${randomUUID()}`)

    const blocked = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.equal(blocked.kind, 'blocked')
    assert.deepEqual(
      blocked.kind === 'blocked' ? blocked.blocks.map((block) => block.code) : [],
      ['PROJECT_HAS_EXTERNAL_TEAMS'],
    )
    // The local half of a UOA-owned object is still there.
    assert.equal(await prisma.team.count({ where: { id: bound.id } }), 1)

    // A team Nessie owns outright is not a reason to refuse: it is hidden with
    // the project, which is the only thing it exists inside.
    await prisma.team.update({
      where: { id: bound.id },
      data: { externalTeamId: null },
    })
    const deleted = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(deleted, { kind: 'deleted' })
    // Soft: the team row is kept with the project for a restore.
    assert.equal(await prisma.team.count({ where: { id: bound.id } }), 1)
  })
})

runDatabaseTest('every blocking family is reported at once', async () => {
  await withSeed(async (prisma, sown) => {
    const team = await addTeam(prisma, sown, `uoa-${randomUUID()}`)
    await prisma.channel.create({
      data: {
        label: 'launch',
        slug: 'launch',
        organizationId: sown.organizationId,
        projectId: sown.projectId,
        teamId: team.id,
      },
    })
    await prisma.knowledgeSpace.create({
      data: {
        name: 'Handbook',
        createdBy: sown.userId,
        organizationId: sown.organizationId,
        projectId: sown.projectId,
      },
    })

    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.equal(result.kind, 'blocked')
    assert.deepEqual(
      result.kind === 'blocked' ? result.blocks.map((block) => block.code) : [],
      ['PROJECT_HAS_KNOWLEDGE', 'PROJECT_HAS_EXTERNAL_TEAMS'],
    )
  })
})
