import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  pauseAgentTrigger,
  resumeAgentTrigger,
  TriggerResumeError,
} from '../src/services/trigger-crud.js'
import { reauthorizeAgentTrigger } from '../src/services/trigger-reauthorize.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Fixture = {
  agentId: string
  channelId: string
  failedDeliveryId: string
  organizationId: string
  pendingRunId: string
  pendingTaskId: string
  projectId: string
  teamId: string
  triggerId: string
  userId: string
}

const seed = async (
  prisma: PrismaClient,
  healthReason: 'agent_channel_access_lost' | 'channel_access_lost',
): Promise<Fixture> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `trigger membership recovery ${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'public channel',
      organizationId: organization.id,
      projectId: project.id,
      slug: `membership-${suffix}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const user = await prisma.user.create({
    data: {
      displayName: 'Schedule owner',
      email: `schedule-owner-${suffix}@example.test`,
    },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id } })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      name: 'Morning Joke',
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: {
        createdByUserId: user.id,
        interval_minutes: 60,
        launchOrigin: {
          organizationId: organization.id,
          projectId: project.id,
          teamId: team.id,
          userId: user.id,
        },
      },
      enabled: true,
      healthDetail: 'membership was removed',
      healthReason,
      nextRunAt: new Date(Date.now() - 60_000),
      status: 'error',
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'interval',
    },
  })
  const failedDelivery = await prisma.agentTriggerDelivery.create({
    data: {
      dedupeKey: `failed-${suffix}`,
      nextRetryAt: new Date(Date.now() - 60_000),
      retryCount: 1,
      status: 'failed',
      triggerId: trigger.id,
    },
  })
  const queuedDelivery = await prisma.agentTriggerDelivery.create({
    data: {
      dedupeKey: `queued-${suffix}`,
      status: 'delivered',
      triggerId: trigger.id,
    },
  })
  const pendingRun = await prisma.run.create({
    data: {
      agentId: agent.id,
      status: 'pending',
      threadId: thread.id,
      triggerDeliveryId: queuedDelivery.id,
      triggerId: trigger.id,
    },
  })
  const pendingTask = await prisma.task.create({
    data: {
      agentId: agent.id,
      organizationId: organization.id,
      runId: pendingRun.id,
      status: 'inbox',
    },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    failedDeliveryId: failedDelivery.id,
    organizationId: organization.id,
    pendingRunId: pendingRun.id,
    pendingTaskId: pendingTask.id,
    projectId: project.id,
    teamId: team.id,
    triggerId: trigger.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, fixture: Fixture): Promise<void> => {
  await prisma.organization.delete({ where: { id: fixture.organizationId } })
  await prisma.user.deleteMany({ where: { id: fixture.userId } })
}

runDatabaseTest('an errored schedule resumes only after its agent is back', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 'agent_channel_access_lost')
  const scope = {
    organizationId: fixture.organizationId,
    triggerId: fixture.triggerId,
  }

  try {
    await prisma.agentBinding.deleteMany({
      where: { agentId: fixture.agentId, channelId: fixture.channelId },
    })

    const paused = await pauseAgentTrigger(prisma, scope)
    assert.equal(paused?.enabled, false)
    assert.equal(paused?.status, 'error', 'an operator pause must preserve diagnosed health')
    assert.equal(paused?.healthReason, 'agent_channel_access_lost')

    await assert.rejects(
      resumeAgentTrigger(prisma, scope),
      (error: unknown) =>
        error instanceof TriggerResumeError
        && /Add the agent back/.test(error.message),
    )

    await prisma.agentBinding.create({
      data: { agentId: fixture.agentId, channelId: fixture.channelId },
    })
    const resumedAfter = Date.now()
    const resumed = await resumeAgentTrigger(prisma, scope)

    assert.equal(resumed?.enabled, true)
    assert.equal(resumed?.status, 'active')
    assert.equal(resumed?.healthReason, undefined)
    assert.ok(Date.parse(resumed?.nextRunAt ?? '') > resumedAfter)
    const failedDelivery = await prisma.agentTriggerDelivery.findUniqueOrThrow({
      where: { id: fixture.failedDeliveryId },
      select: { nextRetryAt: true },
    })
    assert.equal(failedDelivery.nextRetryAt, null)
    const pendingRun = await prisma.run.findUniqueOrThrow({
      where: { id: fixture.pendingRunId },
      select: { finishedAt: true, status: true },
    })
    assert.equal(pendingRun.status, 'cancelled')
    assert.ok(pendingRun.finishedAt)
    assert.equal(
      (await prisma.task.findUniqueOrThrow({
        where: { id: fixture.pendingTaskId },
        select: { status: true },
      })).status,
      'cancelled',
    )
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a public-channel schedule resumes only after its user is back', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 'channel_access_lost')
  const scope = {
    organizationId: fixture.organizationId,
    triggerId: fixture.triggerId,
  }

  try {
    await prisma.channelMember.deleteMany({
      where: { channelId: fixture.channelId, userId: fixture.userId },
    })
    await assert.rejects(
      resumeAgentTrigger(prisma, scope),
      (error: unknown) =>
        error instanceof TriggerResumeError
        && /Add the person back/.test(error.message),
    )

    await prisma.channelMember.create({
      data: { channelId: fixture.channelId, userId: fixture.userId },
    })
    assert.equal((await resumeAgentTrigger(prisma, scope))?.status, 'active')
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a paused public-channel schedule rechecks its user before resuming', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 'channel_access_lost')
  const scope = {
    organizationId: fixture.organizationId,
    triggerId: fixture.triggerId,
  }

  try {
    await prisma.agentTrigger.update({
      where: { id: fixture.triggerId },
      data: {
        enabled: false,
        healthDetail: null,
        healthReason: null,
        status: 'paused',
      },
    })
    await prisma.channelMember.deleteMany({
      where: { channelId: fixture.channelId, userId: fixture.userId },
    })

    await assert.rejects(
      resumeAgentTrigger(prisma, scope),
      (error: unknown) =>
        error instanceof TriggerResumeError
        && /Add the person back/.test(error.message),
    )
    const stillPaused = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: fixture.triggerId },
      select: { enabled: true, status: true },
    })
    assert.equal(stillPaused.enabled, false)
    assert.equal(stillPaused.status, 'paused')
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})

runDatabaseTest('reauthorizing an explicitly disabled schedule enables it again', async () => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma, 'channel_access_lost')

  try {
    await prisma.agentTrigger.update({
      where: { id: fixture.triggerId },
      data: {
        enabled: false,
        healthReason: 'uoa_identity_unverifiable',
        status: 'needs_reauthorization',
      },
    })
    const actorContext: AuthorizedActionContext = {
      actor: { actorId: fixture.userId, actorType: 'user', roles: ['owner'] },
      actionContext: { requestId: 'trigger-membership-recovery' },
      tenant: {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        teamId: fixture.teamId,
      },
    }
    const result = await reauthorizeAgentTrigger(prisma, {
      actorContext,
      isOwner: true,
      triggerId: fixture.triggerId,
    })

    assert.equal(result.kind, 'ok')
    if (result.kind === 'ok') {
      assert.equal(result.trigger.enabled, true)
      assert.equal(result.trigger.status, 'active')
    }
  } finally {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  }
})
