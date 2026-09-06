import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { agentDmKey, resolveAgentConversation } from '../src/agent-conversation.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  userId: string
  sharedAgentId: string
  systemAgentId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Adder', email: `adder-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `conv-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id, role: 'owner' },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `team-${suffix}`, projectId: project.id },
  })
  const sharedAgent = await prisma.agent.create({
    data: {
      name: 'Triage',
      organizationId: organization.id,
      projectId: project.id,
      role: 'assistant',
      visibility: 'team',
    },
  })
  const systemAgent = await prisma.agent.create({
    data: {
      name: 'Agent Designer',
      organizationId: organization.id,
      projectId: project.id,
      role: 'assistant',
      systemManaged: true,
      systemSlug: `designer-${suffix}`,
      visibility: 'team',
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    userId: user.id,
    sharedAgentId: sharedAgent.id,
    systemAgentId: systemAgent.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

runDatabaseTest('a shared agent is reachable in its DM with the person who added it', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const target = await resolveAgentConversation(prisma, {
      agentId: seeded.sharedAgentId,
      organizationId: seeded.organizationId,
      onBehalfOfUserId: seeded.userId,
      teamId: seeded.teamId,
    })
    assert.ok(target, 'a shared agent should be reachable')
    // The wake needs a binding, or the run would be refused downstream.
    const binding = await prisma.agentBinding.count({
      where: { agentId: seeded.sharedAgentId, channelId: target.channelId },
    })
    assert.equal(binding, 1)
    const channel = await prisma.channel.findUnique({
      where: { id: target.channelId },
      select: { dmKey: true },
    })
    assert.equal(
      channel?.dmKey,
      agentDmKey({
        agentId: seeded.sharedAgentId,
        organizationId: seeded.organizationId,
        teamId: seeded.teamId,
        userId: seeded.userId,
      }),
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('resolving twice returns the same conversation', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const first = await resolveAgentConversation(prisma, {
      agentId: seeded.sharedAgentId,
      organizationId: seeded.organizationId,
      onBehalfOfUserId: seeded.userId,
      teamId: seeded.teamId,
    })
    const second = await resolveAgentConversation(prisma, {
      agentId: seeded.sharedAgentId,
      organizationId: seeded.organizationId,
      onBehalfOfUserId: seeded.userId,
      teamId: seeded.teamId,
    })
    // Idempotent, or every ticket that moved would open another DM.
    assert.equal(first?.channelId, second?.channelId)
    assert.equal(first?.threadId, second?.threadId)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a system agent has no conversation to be woken in', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // The same reason `createAgentTrigger` refuses one: a system agent owns no
    // automation, so a watcher naming it could never fire.
    assert.equal(
      await resolveAgentConversation(prisma, {
        agentId: seeded.systemAgentId,
        organizationId: seeded.organizationId,
        onBehalfOfUserId: seeded.userId,
        teamId: seeded.teamId,
      }),
      null,
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent from another organisation is not reachable', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  const other = await seed(prisma)
  try {
    assert.equal(
      await resolveAgentConversation(prisma, {
        agentId: other.sharedAgentId,
        organizationId: seeded.organizationId,
        onBehalfOfUserId: seeded.userId,
        teamId: seeded.teamId,
      }),
      null,
    )
  } finally {
    await cleanup(prisma, seeded)
    await cleanup(prisma, other)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the DM key is the session team, not a team this layer chose', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // A project may have several teams. The interactive route keys the DM on
    // the session's team, so anything that picks a different one — "the oldest",
    // say — opens a second DM for the same pair and wakes the agent where
    // nobody is reading.
    const second = await prisma.team.create({
      data: { name: `later-${randomUUID()}`, projectId: seeded.projectId },
    })
    const target = await resolveAgentConversation(prisma, {
      agentId: seeded.sharedAgentId,
      organizationId: seeded.organizationId,
      onBehalfOfUserId: seeded.userId,
      teamId: second.id,
    })
    const channel = await prisma.channel.findUnique({
      where: { id: target?.channelId ?? '' },
      select: { dmKey: true },
    })
    assert.equal(
      channel?.dmKey,
      agentDmKey({
        agentId: seeded.sharedAgentId,
        organizationId: seeded.organizationId,
        teamId: second.id,
        userId: seeded.userId,
      }),
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
