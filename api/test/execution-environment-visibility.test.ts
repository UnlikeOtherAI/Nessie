import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { createAgentRecord } from '@nessie/team-admin'

import {
  EXECUTION_ENVIRONMENT_ERROR_CODES,
  ExecutionEnvironmentError,
  listExecutionEnvironmentInstances,
  requestExecutionEnvironmentLaunch,
} from '../src/services/execution-environments.js'

/**
 * Execution environments carry references to agents and runs. They are not an
 * organization-owner back door: these assertions use a real database so the
 * relation predicates have to exclude another owner's private agent before
 * either a launch or an instance list reaches it.
 */

const suite = 'eea1'
const organizationId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const privateChannelId = `00000000-0000-4000-8000-${suite}00000004`
const ownerId = `00000000-0000-4000-8000-${suite}00000010`
const otherOwnerId = `00000000-0000-4000-8000-${suite}00000011`

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorContext = (userId: string) => ({
  actionContext: { requestId: `execution-environment-${suite}` },
  actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId, projectId, teamId },
}) as AuthorizedActionContext

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: organizationId, name: `execution-${suite}` } })
  await prisma.user.createMany({
    data: [ownerId, otherOwnerId].map((id, index) => ({
      displayName: `Execution owner ${index}`,
      email: `execution-${suite}-${index}@test.local`,
      id,
    })),
  })
  await prisma.organizationMember.createMany({
    data: [ownerId, otherOwnerId].map((userId) => ({
      organizationId,
      role: 'owner',
      userId,
    })),
  })
  await prisma.project.create({ data: { id: projectId, name: `project-${suite}`, organizationId } })
  await prisma.team.create({ data: { id: teamId, name: `team-${suite}`, projectId } })
  await prisma.channel.create({
    data: {
      id: privateChannelId,
      label: `private-${suite}`,
      organizationId,
      projectId,
      slug: `private-${suite}`,
      teamId,
      visibility: 'private',
    },
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma.executionEnvironmentInstance.deleteMany({ where: { organizationId } })
  await prisma.executionEnvironmentTemplate.deleteMany({ where: { organizationId } })
  await prisma.agent.deleteMany({ where: { organizationId } })
  await prisma.channel.deleteMany({ where: { id: privateChannelId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
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

dbTest('execution environments preserve private-agent visibility for launch and listing', async () => {
  await withDb(async (prisma) => {
    const [ownPrivate, otherPrivate, shared] = await Promise.all([
      createAgentRecord(prisma, {
        name: `own-private-${suite}`,
        organizationId,
        ownerUserId: ownerId,
        projectId,
        role: 'assistant',
        teamId,
        visibility: 'private',
      }),
      createAgentRecord(prisma, {
        name: `other-private-${suite}`,
        organizationId,
        ownerUserId: otherOwnerId,
        projectId,
        role: 'assistant',
        teamId,
        visibility: 'private',
      }),
      createAgentRecord(prisma, {
        name: `shared-${suite}`,
        organizationId,
        ownerUserId: otherOwnerId,
        projectId,
        role: 'assistant',
        teamId,
        visibility: 'team',
      }),
    ])
    const template = await prisma.executionEnvironmentTemplate.create({
      data: {
        createdByActorId: ownerId,
        createdByActorType: 'user',
        mode: 'container',
        name: `template-${suite}`,
        organizationId,
        provider: 'docker',
      },
    })
    const privateThread = await prisma.thread.create({ data: { channelId: privateChannelId } })
    const otherPrivateRun = await prisma.run.create({
      data: { agentId: otherPrivate.id, threadId: privateThread.id },
    })

    await assert.rejects(
      () => requestExecutionEnvironmentLaunch(prisma, actorContext(ownerId), {
        agentId: otherPrivate.id,
        templateId: template.id,
      }),
      (error: unknown) => error instanceof ExecutionEnvironmentError
        && error.code === EXECUTION_ENVIRONMENT_ERROR_CODES.AGENT_NOT_FOUND,
    )
    await assert.rejects(
      () => requestExecutionEnvironmentLaunch(prisma, actorContext(ownerId), {
        runId: otherPrivateRun.id,
        templateId: template.id,
      }),
      (error: unknown) => error instanceof ExecutionEnvironmentError
        && error.code === EXECUTION_ENVIRONMENT_ERROR_CODES.RUN_NOT_FOUND,
    )

    await prisma.executionEnvironmentInstance.createMany({
      data: [ownPrivate, otherPrivate, shared].map((agent) => ({
        agentId: agent.id,
        launchedByActorId: ownerId,
        launchedByActorType: 'user',
        organizationId,
        templateId: template.id,
      })),
    })

    const visible = await listExecutionEnvironmentInstances(prisma, {
      organizationId,
      userId: ownerId,
    }, {})
    assert.deepEqual(
      new Set(visible.map((instance) => instance.agentId)),
      new Set([ownPrivate.id, shared.id]),
    )
  })
})
