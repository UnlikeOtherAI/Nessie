import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { ensurePrivateAgentHome, setBoardWatchers } from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  adderId: string
  boardId: string
  organizationId: string
  otherId: string
  otherPrivateAgentId: string
  ownPrivateAgentId: string
  sharedAgentId: string
  systemAgentId: string
  teamId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const adder = await prisma.user.create({
    data: { displayName: 'Adder', email: `watch-adder-${suffix}@example.test` },
  })
  const other = await prisma.user.create({
    data: { displayName: 'Other', email: `watch-other-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `watch-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: adder.id, role: 'owner' },
      { organizationId: organization.id, userId: other.id, role: 'member' },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: {
      organizationId: organization.id,
      projectId: project.id,
      name: 'Watch board',
      isDefault: true,
      position: 0,
    },
  })
  const [shared, ownPrivate, otherPrivate, system] = await Promise.all([
    prisma.agent.create({
      data: {
        name: 'Shared watcher',
        organizationId: organization.id,
        projectId: project.id,
        teamId: team.id,
        role: 'assistant',
        visibility: 'team',
      },
    }),
    prisma.agent.create({
      data: {
        name: 'My private watcher',
        organizationId: organization.id,
        ownerUserId: adder.id,
        projectId: project.id,
        teamId: team.id,
        role: 'assistant',
        visibility: 'private',
      },
    }),
    prisma.agent.create({
      data: {
        name: 'Other private watcher',
        organizationId: organization.id,
        ownerUserId: other.id,
        projectId: project.id,
        teamId: team.id,
        role: 'assistant',
        visibility: 'private',
      },
    }),
    prisma.agent.create({
      data: {
        name: 'System watcher',
        organizationId: organization.id,
        projectId: project.id,
        role: 'assistant',
        systemManaged: true,
        systemSlug: `system-${suffix}`,
        visibility: 'team',
      },
    }),
  ])
  await ensurePrivateAgentHome(prisma, {
    agentId: ownPrivate.id,
    label: ownPrivate.name,
    organizationId: organization.id,
    ownerUserId: adder.id,
    teamId: team.id,
  })
  return {
    adderId: adder.id,
    boardId: board.id,
    organizationId: organization.id,
    otherId: other.id,
    otherPrivateAgentId: otherPrivate.id,
    ownPrivateAgentId: ownPrivate.id,
    sharedAgentId: shared.id,
    systemAgentId: system.id,
    teamId: team.id,
  }
}

const watcherInput = (seeded: Seed) => ({
  addedByUserId: seeded.adderId,
  boardId: seeded.boardId,
  organizationId: seeded.organizationId,
  origin: { teamId: seeded.teamId },
})

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: [seeded.adderId, seeded.otherId] } } })
}

runDatabaseTest('another person’s private agent is refused before a DM or watcher row is written', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    assert.deepEqual(
      await setBoardWatchers(prisma, {
        ...watcherInput(seeded),
        watchers: [{ kind: 'agent', id: seeded.otherPrivateAgentId }],
      }),
      { error: 'RECIPIENT_NOT_REACHABLE', recipientId: seeded.otherPrivateAgentId },
    )
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId } }), 0)
    assert.equal(await prisma.channel.count({ where: { organizationId: seeded.organizationId } }), 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the adder’s private agent and an ordinary shared agent are valid watchers', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const watchers = await setBoardWatchers(prisma, {
      ...watcherInput(seeded),
      watchers: [
        { kind: 'agent', id: seeded.ownPrivateAgentId },
        { kind: 'agent', id: seeded.sharedAgentId },
      ],
    })
    assert.ok(Array.isArray(watchers), JSON.stringify(watchers))
    assert.deepEqual(
      watchers.map((watcher) => watcher.recipientId).sort(),
      [seeded.ownPrivateAgentId, seeded.sharedAgentId].sort(),
    )
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId } }), 2)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a private agent is unreachable after its owner leaves the organisation', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: seeded.organizationId, userId: seeded.adderId } },
      data: { deactivatedAt: new Date() },
    })
    assert.deepEqual(
      await setBoardWatchers(prisma, {
        ...watcherInput(seeded),
        watchers: [{ kind: 'agent', id: seeded.ownPrivateAgentId }],
      }),
      { error: 'RECIPIENT_NOT_REACHABLE', recipientId: seeded.ownPrivateAgentId },
    )
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId } }), 0)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('system agents are refused before a watcher list is replaced', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    assert.deepEqual(
      await setBoardWatchers(prisma, {
        ...watcherInput(seeded),
        watchers: [{ kind: 'agent', id: seeded.systemAgentId }],
      }),
      { error: 'RECIPIENT_NOT_REACHABLE', recipientId: seeded.systemAgentId },
    )
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId } }), 0)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
