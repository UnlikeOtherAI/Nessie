import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  addPersonalAssistantPresence,
  removePersonalAssistantPresence,
} from '@nessie/workspace-admin'

import { ensurePersonalAssistantBootstrap } from '../src/services/personal-assistant.js'
import { setOrganizationMemberDeactivated } from '../src/services/users.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * PA presence is a database invariant, not merely a route convention. This
 * exercises the partial key, channel-member FK cascade, and deactivation path
 * against Postgres rather than a Prisma fake.
 */
dbTest('a shared channel keeps one PA presence per live member and removes it on leave or deactivation', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const firstUserId = randomUUID()
  const secondUserId = randomUUID()
  const managerUserId = randomUUID()

  try {
    await prisma.organization.create({
      data: { id: organizationId, name: `pa-presence-${organizationId}` },
    })
    await prisma.user.createMany({
      data: [
        { id: firstUserId, email: `${firstUserId}@test.local`, displayName: 'First' },
        { id: secondUserId, email: `${secondUserId}@test.local`, displayName: 'Second' },
        { id: managerUserId, email: `${managerUserId}@test.local`, displayName: 'Manager' },
      ],
    })
    await prisma.organizationMember.createMany({
      data: [
        { organizationId, role: 'member', userId: firstUserId },
        { organizationId, role: 'member', userId: secondUserId },
        { organizationId, role: 'owner', userId: managerUserId },
      ],
    })
    const project = await prisma.project.create({
      data: { name: `PA presence ${organizationId}`, organizationId },
    })
    const team = await prisma.team.create({
      data: { name: `PA presence ${organizationId}`, projectId: project.id },
    })
    const channel = await prisma.channel.create({
      data: {
        label: 'shared-pa-presence',
        organizationId,
        projectId: project.id,
        slug: `shared-pa-presence-${organizationId}`,
        teamId: team.id,
      },
    })
    await prisma.channelMember.createMany({
      data: [
        { channelId: channel.id, userId: firstUserId },
        { channelId: channel.id, userId: secondUserId },
        { channelId: channel.id, userId: managerUserId },
      ],
    })
    const assistant = await ensurePersonalAssistantBootstrap(prisma, {
      organizationId,
      teamId: team.id,
      userId: firstUserId,
    })

    assert.equal((await addPersonalAssistantPresence(prisma, {
      channelId: channel.id,
      organizationId,
      userId: firstUserId,
    })).kind, 'created')
    assert.equal((await addPersonalAssistantPresence(prisma, {
      channelId: channel.id,
      organizationId,
      userId: secondUserId,
    })).kind, 'created')
    // The partial presence key makes joining idempotent without collapsing the
    // other member's presence onto the singleton PA agent.
    assert.equal((await addPersonalAssistantPresence(prisma, {
      channelId: channel.id,
      organizationId,
      userId: firstUserId,
    })).kind, 'created')
    assert.equal(await prisma.agentBinding.count({
      where: {
        agentId: assistant.agentId,
        channelId: channel.id,
        principalUserId: { not: null },
      },
    }), 2)

    // A member cannot remove somebody else's PA presence; a channel owner can.
    assert.equal((await removePersonalAssistantPresence(prisma, {
      actorUserId: firstUserId,
      channelId: channel.id,
      organizationId,
      principalUserId: secondUserId,
    })).kind, 'forbidden')
    assert.equal((await removePersonalAssistantPresence(prisma, {
      actorUserId: managerUserId,
      channelId: channel.id,
      organizationId,
      principalUserId: secondUserId,
    })).kind, 'deleted')
    assert.equal((await addPersonalAssistantPresence(prisma, {
      channelId: channel.id,
      organizationId,
      userId: secondUserId,
    })).kind, 'created')

    // This is the FK lifecycle floor: any channel-member deletion removes the
    // matching PA binding even if it bypasses the HTTP leave route.
    await prisma.channelMember.delete({
      where: { channelId_userId: { channelId: channel.id, userId: firstUserId } },
    })
    assert.equal(await prisma.agentBinding.count({
      where: { agentId: assistant.agentId, channelId: channel.id, principalUserId: firstUserId },
    }), 0)

    await prisma.channelMember.create({ data: { channelId: channel.id, userId: firstUserId } })
    await addPersonalAssistantPresence(prisma, {
      channelId: channel.id,
      organizationId,
      userId: firstUserId,
    })
    await setOrganizationMemberDeactivated(prisma, {
      actorUserId: managerUserId,
      deactivated: true,
      organizationId,
      requestId: `deactivate-${organizationId}`,
      userId: firstUserId,
    })
    assert.equal(await prisma.agentBinding.count({
      where: { agentId: assistant.agentId, channelId: channel.id, principalUserId: firstUserId },
    }), 0)
    assert.equal(await prisma.agentBinding.count({
      where: { agentId: assistant.agentId, channelId: channel.id, principalUserId: secondUserId },
    }), 1)
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [firstUserId, secondUserId, managerUserId] } } })
    await prisma.$disconnect()
  }
})
