import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  getDemonstrationForUser,
  startDemonstration,
  stopDemonstration,
} from '@nessie/team-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { captureDemonstrationToolEnd } from '../../src/run/execute/demonstration-capture.js'
import { runDatabaseTest } from './support.js'

type Seed = {
  actorContext: AuthorizedActionContext
  agentId: string
  organizationId: string
  runId: string
  threadId: string
  userId: string
}

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `demonstration-${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Demonstrator', email: `demonstration-${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: 'Demonstration project', organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: 'Demonstration team', projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `demonstration-${randomUUID()}`,
      slug: `demonstration-${randomUUID()}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'private',
    },
  })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: 'Demonstration agent',
      organizationId: organization.id,
      ownerUserId: user.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const run = await prisma.run.create({ data: { agentId: agent.id, threadId: thread.id } })
  return {
    actorContext: {
      actionContext: { requestId: randomUUID() },
      actor: { actorId: user.id, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: organization.id, projectId: project.id, teamId: team.id },
    } as AuthorizedActionContext,
    agentId: agent.id,
    organizationId: organization.id,
    runId: run.id,
    threadId: thread.id,
    userId: user.id,
  }
}

runDatabaseTest('armed demonstrations capture ordered redacted steps and stop as review-only drafts', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
    await prisma.user.deleteMany({ where: { id: seed.userId } })
    await prisma.$disconnect()
  })

  const started = await startDemonstration(prisma, {
    actorContext: seed.actorContext,
    agentId: seed.agentId,
    channelId: (await prisma.thread.findUniqueOrThrow({ where: { id: seed.threadId } })).channelId,
    threadId: seed.threadId,
  })
  assert.equal(started.created, true)

  await Promise.all([
    captureDemonstrationToolEnd(prisma, {
      agentId: seed.agentId,
      argumentsValue: { apiKey: 'secret-key', url: 'https://example.com/one' },
      demonstrationId: started.demonstration.id,
      durationMs: 12,
      endedAt: new Date(),
      organizationId: seed.organizationId,
      runId: seed.runId,
      startedAt: new Date(),
      success: true,
      threadId: seed.threadId,
      toolName: 'web_fetch',
    }),
    captureDemonstrationToolEnd(prisma, {
      agentId: seed.agentId,
      argumentsValue: { query: 'release notes' },
      demonstrationId: started.demonstration.id,
      durationMs: 8,
      endedAt: new Date(),
      organizationId: seed.organizationId,
      runId: seed.runId,
      startedAt: new Date(),
      success: false,
      threadId: seed.threadId,
      toolName: 'web_search',
    }),
  ])

  const stopped = await stopDemonstration(prisma, {
    actorContext: seed.actorContext,
    demonstrationId: started.demonstration.id,
  })
  assert.equal(stopped?.status, 'captured')
  assert.equal(stopped?.stepCount, 2)

  const detail = await getDemonstrationForUser(prisma, {
    demonstrationId: started.demonstration.id,
    organizationId: seed.organizationId,
    userId: seed.userId,
  })
  assert.deepEqual(detail?.steps.map((step) => step.sequence), [1, 2])
  assert.equal(JSON.stringify(detail?.steps).includes('secret-key'), false)
  assert.equal(JSON.stringify(detail?.steps).includes('[REDACTED]'), true)
})
