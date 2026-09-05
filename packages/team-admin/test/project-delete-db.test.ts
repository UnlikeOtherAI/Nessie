import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createProjectForUser, deleteProject } from '../src/index.js'

/**
 * What deleting a project destroys.
 *
 * Every one of these families used to be a live hard-cascade behind a route
 * guard that knew about exactly one of them (`channelCount > 0`), so a Prisma
 * fake would prove nothing: the whole point is what the FOREIGN KEYS do, and
 * these run against a real database. Each refusal below is a family the old
 * `prisma.project.delete()` would have taken with it — or, for executors,
 * crashed on with an unhandled P2003.
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
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await createProjectForUser(prisma, {
    name: `Deletable ${suffix}`,
    organizationId: organization.id,
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

runDatabaseTest('an empty project is deleted', async () => {
  await withSeed(async (prisma, sown) => {
    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(result, { kind: 'deleted' })
    assert.equal(
      await prisma.project.count({ where: { id: sown.projectId } }),
      0,
    )
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

runDatabaseTest('channels refuse the delete and survive it', async () => {
  await withSeed(async (prisma, sown) => {
    const team = await addTeam(prisma, sown)
    const channel = await prisma.channel.create({
      data: {
        label: 'general',
        slug: 'general',
        organizationId: sown.organizationId,
        projectId: sown.projectId,
        teamId: team.id,
      },
    })

    const result = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.equal(result.kind, 'blocked')
    assert.deepEqual(
      result.kind === 'blocked' ? result.blocks.map((block) => block.code) : [],
      ['PROJECT_NOT_EMPTY'],
    )
    assert.equal(await prisma.channel.count({ where: { id: channel.id } }), 1)
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

    // A team Nessie owns outright is not a reason to refuse: it goes with the
    // project, which is the only thing it exists inside.
    await prisma.team.update({
      where: { id: bound.id },
      data: { externalTeamId: null },
    })
    const deleted = await deleteProject(prisma, {
      organizationId: sown.organizationId,
      projectId: sown.projectId,
    })
    assert.deepEqual(deleted, { kind: 'deleted' })
    assert.equal(await prisma.team.count({ where: { id: bound.id } }), 0)
  })
})

runDatabaseTest('every blocking family is reported at once', async () => {
  await withSeed(async (prisma, sown) => {
    const team = await addTeam(prisma, sown, `uoa-${randomUUID()}`)
    await prisma.channel.create({
      data: {
        label: 'general',
        slug: 'general',
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
      ['PROJECT_NOT_EMPTY', 'PROJECT_HAS_KNOWLEDGE', 'PROJECT_HAS_EXTERNAL_TEAMS'],
    )
  })
})
