import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  addPersonalAssistantPresence,
  isAgentAccessibleToActor,
  removePersonalAssistantPresence,
} from '@nessie/team-admin'

import { listChannelsForUser } from '../src/services/channels.js'
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

dbTest('a PA presence is a viewer-relative participant projection, never an agent detail', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ownerUserId = randomUUID()
  const peerUserId = randomUUID()

  try {
    await prisma.organization.create({ data: { id: organizationId, name: `pa-ui-${organizationId}` } })
    await prisma.user.createMany({
      data: [
        { id: ownerUserId, email: `${ownerUserId}@test.local`, displayName: 'Owner' },
        { id: peerUserId, email: `${peerUserId}@test.local`, displayName: 'Peer' },
      ],
    })
    await prisma.organizationMember.createMany({
      data: [
        { organizationId, role: 'member', userId: ownerUserId },
        { organizationId, role: 'member', userId: peerUserId },
      ],
    })
    const project = await prisma.project.create({ data: { name: `pa-ui-${organizationId}`, organizationId } })
    const team = await prisma.team.create({ data: { name: `pa-ui-${organizationId}`, projectId: project.id } })
    const channel = await prisma.channel.create({
      data: {
        label: 'pa-ui',
        organizationId,
        projectId: project.id,
        slug: `pa-ui-${organizationId}`,
        teamId: team.id,
      },
    })
    await prisma.channelMember.createMany({
      data: [
        { channelId: channel.id, userId: ownerUserId },
        { channelId: channel.id, userId: peerUserId },
      ],
    })
    const assistant = await ensurePersonalAssistantBootstrap(prisma, {
      organizationId,
      teamId: team.id,
      userId: ownerUserId,
    })
    await addPersonalAssistantPresence(prisma, { channelId: channel.id, organizationId, userId: ownerUserId })
    await addPersonalAssistantPresence(prisma, { channelId: channel.id, organizationId, userId: peerUserId })

    const ownerChannel = (await listChannelsForUser(prisma, ownerUserId, organizationId)).find(
      (entry) => entry.id === channel.id,
    )
    const peerChannel = (await listChannelsForUser(prisma, peerUserId, organizationId)).find(
      (entry) => entry.id === channel.id,
    )
    assert.ok(ownerChannel)
    assert.ok(peerChannel)
    assert.deepEqual(
      ownerChannel.personalAssistantPresences?.map(({ displayName, mentionName, principalUserId }) => ({
        displayName,
        mentionName,
        principalUserId,
      })),
      [
        { displayName: 'Personal Assistant', mentionName: 'Owner – PA', principalUserId: ownerUserId },
        { displayName: 'Peer – PA', mentionName: 'Peer – PA', principalUserId: peerUserId },
      ],
    )
    assert.equal(
      peerChannel.personalAssistantPresences?.find((presence) => presence.principalUserId === peerUserId)?.displayName,
      'Personal Assistant',
    )
    assert.equal(
      peerChannel.personalAssistantPresences?.find((presence) => presence.principalUserId === ownerUserId)?.displayName,
      'Owner – PA',
    )

    // Every /api/agents/:id detail route maps this gate to AGENT_NOT_FOUND
    // (404), keeping the singleton's AgentRecord out of a channel peer's UI.
    const peerContext = {
      actionContext: { requestId: `pa-ui-${organizationId}` },
      actor: { actorId: peerUserId, actorType: 'user' as const, roles: ['member'] },
      tenant: { organizationId },
    }
    assert.equal(await isAgentAccessibleToActor(prisma, peerContext, assistant.agentId), false)
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, peerUserId] } } })
    await prisma.$disconnect()
  }
})
