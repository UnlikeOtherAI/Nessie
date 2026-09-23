import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  AGENT_WATCHERS_RETIRED_SENTENCE,
  ensurePrivateAgentHome,
  listBoardWatchers,
  setBoardWatchers,
} from '../src/index.js'

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
  const sharedChannel = await prisma.channel.create({
    data: {
      label: `shared-watch-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `shared-watch-${suffix}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  await prisma.agentBinding.create({
    data: { agentId: shared.id, channelId: sharedChannel.id },
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
})

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: [seeded.adderId, seeded.otherId] } } })
}

runDatabaseTest('an agent recipient is refused in words, and nothing is written', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // Every kind of agent, beside a person: the list is refused whole, with the
    // sentence that says where agent wakes moved.
    for (const agentId of [seeded.sharedAgentId, seeded.ownPrivateAgentId, seeded.systemAgentId]) {
      assert.deepEqual(
        await setBoardWatchers(prisma, {
          ...watcherInput(seeded),
          watchers: [{ kind: 'user', id: seeded.otherId }, { kind: 'agent', id: agentId }],
        }),
        { error: 'AGENT_WATCHERS_RETIRED', recipientId: agentId },
      )
    }
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId } }), 0)
    assert.match(AGENT_WATCHERS_RETIRED_SENTENCE, /Agents start work from the column menu/)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('people watchers are saved and listed; a legacy agent row is not listed', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.boardWatcher.create({
      data: {
        addedByUserId: seeded.adderId,
        agentId: seeded.sharedAgentId,
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
      },
    })
    const watchers = await setBoardWatchers(prisma, {
      ...watcherInput(seeded),
      watchers: [{ kind: 'user', id: seeded.otherId }, { kind: 'user', id: seeded.adderId }],
    })
    assert.ok(Array.isArray(watchers), JSON.stringify(watchers))
    assert.deepEqual(watchers.map((watcher) => [watcher.kind, watcher.recipientId]).sort(), [
      ['user', seeded.adderId],
      ['user', seeded.otherId],
    ].sort())
    // The save replaced the whole list, the legacy agent row with it.
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId, agentId: { not: null } } }), 0)
    await prisma.boardWatcher.create({
      data: {
        addedByUserId: seeded.adderId,
        agentId: seeded.sharedAgentId,
        boardId: seeded.boardId,
        organizationId: seeded.organizationId,
      },
    })
    const listed = await listBoardWatchers(prisma, {
      boardId: seeded.boardId,
      organizationId: seeded.organizationId,
      userId: seeded.adderId,
    })
    assert.deepEqual(listed.map((watcher) => watcher.kind), ['user', 'user'])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a person outside the organisation is not reachable', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: seeded.organizationId, userId: seeded.otherId } },
      data: { deactivatedAt: new Date() },
    })
    assert.deepEqual(
      await setBoardWatchers(prisma, { ...watcherInput(seeded), watchers: [{ kind: 'user', id: seeded.otherId }] }),
      { error: 'RECIPIENT_NOT_REACHABLE', recipientId: seeded.otherId },
    )
    assert.equal(await prisma.boardWatcher.count({ where: { boardId: seeded.boardId } }), 0)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
