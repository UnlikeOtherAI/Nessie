import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { createAgentRecord } from '@nessie/workspace-admin'

import { countPausedPrivateAgents } from '../src/services/private-agent-lifecycle.js'
import { setOrganizationMemberDeactivated } from '../src/services/users.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('owner deactivation pauses only private-agent triggers exactly once', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const ownerUserId = randomUUID()
  const actorUserId = randomUUID()

  try {
    await prisma.organization.create({
      data: { id: organizationId, name: `private-lifecycle-${organizationId}` },
    })
    await prisma.user.createMany({
      data: [
        { id: ownerUserId, email: `${ownerUserId}@test.local`, displayName: 'Agent owner' },
        { id: actorUserId, email: `${actorUserId}@test.local`, displayName: 'Org owner' },
      ],
    })
    await prisma.organizationMember.createMany({
      data: [
        { organizationId, userId: ownerUserId, role: 'member' },
        { organizationId, userId: actorUserId, role: 'owner' },
      ],
    })
    const project = await prisma.project.create({
      data: { name: 'Lifecycle project', organizationId },
    })
    const team = await prisma.team.create({
      data: { name: 'Lifecycle team', projectId: project.id },
    })
    const workspaceChannel = await prisma.channel.create({
      data: {
        label: 'Workspace delivery',
        organizationId,
        projectId: project.id,
        slug: `workspace-delivery-${organizationId}`,
        teamId: team.id,
      },
    })
    const workspaceThread = await prisma.thread.create({
      data: { channelId: workspaceChannel.id },
    })
    const privateAgent = await createAgentRecord(prisma, {
      name: 'Private lifecycle agent',
      organizationId,
      ownerUserId,
      role: 'assistant',
      teamId: team.id,
      visibility: 'private',
    })
    const workspaceAgent = await createAgentRecord(prisma, {
      name: 'Workspace lifecycle agent',
      organizationId,
      ownerUserId,
      role: 'assistant',
      teamId: team.id,
    })
    assert.ok(privateAgent.homeChannelId)
    const privateThread = await prisma.thread.findFirstOrThrow({
      where: { channelId: privateAgent.homeChannelId },
      select: { id: true },
    })
    const [privateTrigger, workspaceTrigger] = await Promise.all([
      prisma.agentTrigger.create({
        data: {
          agentId: privateAgent.id,
          config: { interval_minutes: 15 },
          targetChannelId: privateAgent.homeChannelId,
          targetThreadId: privateThread.id,
          type: 'interval',
        },
      }),
      prisma.agentTrigger.create({
        data: {
          agentId: workspaceAgent.id,
          config: { interval_minutes: 15 },
          targetChannelId: workspaceChannel.id,
          targetThreadId: workspaceThread.id,
          type: 'interval',
        },
      }),
    ])

    const input = {
      actorUserId,
      deactivated: true,
      organizationId,
      requestId: `deactivate-${organizationId}`,
      userId: ownerUserId,
    }
    await setOrganizationMemberDeactivated(prisma, input)
    await setOrganizationMemberDeactivated(prisma, input)

    assert.equal(
      await countPausedPrivateAgents(prisma, organizationId),
      1,
      'the owner-only Members signal reports only the paused private agent count',
    )

    const [pausedPrivate, untouchedWorkspace] = await Promise.all([
      prisma.agentTrigger.findUniqueOrThrow({ where: { id: privateTrigger.id } }),
      prisma.agentTrigger.findUniqueOrThrow({ where: { id: workspaceTrigger.id } }),
    ])
    assert.equal(pausedPrivate.enabled, false)
    assert.equal(pausedPrivate.status, 'paused')
    assert.equal(pausedPrivate.healthReason, 'private_agent_owner_deactivated')
    assert.equal(pausedPrivate.healthRevision, 1)
    assert.equal(pausedPrivate.nextRunAt, null)
    assert.equal(untouchedWorkspace.enabled, true)
    assert.equal(untouchedWorkspace.status, 'active')
    assert.equal(untouchedWorkspace.healthRevision, 0)

    assert.equal(await prisma.auditLog.count({
      where: {
        action: 'agent.private.paused_owner_deactivated',
        organizationId,
        resourceId: ownerUserId,
      },
    }), 1)
    assert.equal(await prisma.userAlert.count({ where: { organizationId } }), 0)

    await setOrganizationMemberDeactivated(prisma, { ...input, deactivated: false })
    assert.equal(await countPausedPrivateAgents(prisma, organizationId), 0)
    const afterReactivation = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: privateTrigger.id },
    })
    assert.equal(afterReactivation.enabled, false)
    assert.equal(afterReactivation.status, 'paused')
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, actorUserId] } } })
    await prisma.$disconnect()
  }
})
