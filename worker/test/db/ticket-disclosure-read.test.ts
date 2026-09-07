import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import {
  runTicketListTool,
  runTicketReadTool,
} from '../../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

type Seed = {
  agentId: string
  organizationId: string
  ownerId: string
  privateTaskId: string
  projectId: string
  publicChannelId: string
  publicTaskId: string
  sourceAuthorId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `ticket-owner-${suffix}@example.test` },
  })
  const sourceAuthor = await prisma.user.create({
    data: { displayName: 'Source author', email: `ticket-source-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `ticket-disclosure-${suffix}` },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: sourceAuthor.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `ticket-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `ticket-team-${suffix}`, projectId: project.id } })
  const publicChannel = await prisma.channel.create({
    data: {
      label: `tickets-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `tickets-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const privateChannel = await prisma.channel.create({
    data: {
      label: `source-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `source-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'private',
    },
  })
  await prisma.channelMember.create({ data: { channelId: privateChannel.id, userId: sourceAuthor.id } })
  const publicThread = await prisma.thread.create({ data: { channelId: publicChannel.id } })
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'personal_assistant',
      delegationMode: 'act_as_requesting_user',
      name: `ticket-agent-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      surfacePolicy: 'dm_only',
      systemManaged: true,
      teamId: team.id,
    },
  })
  const [privateRun, publicRun] = await Promise.all([
    prisma.run.create({ data: { agentId: agent.id, status: 'completed', threadId: publicThread.id } }),
    prisma.run.create({ data: { agentId: agent.id, status: 'completed', threadId: publicThread.id } }),
  ])
  await prisma.runBasisScope.create({
    data: {
      organizationId: organization.id,
      runId: privateRun.id,
      scopeId: privateChannel.id,
      scopeType: 'channel',
    },
  })
  const privateTask = await prisma.task.create({
    data: {
      agentId: agent.id,
      organizationId: organization.id,
      projectId: project.id,
      purpose: 'PRIVATE-TICKET-CANARY',
      runId: privateRun.id,
      status: 'inbox',
      title: 'Private ticket',
    },
  })
  const publicTask = await prisma.task.create({
    data: {
      agentId: agent.id,
      organizationId: organization.id,
      projectId: project.id,
      purpose: 'Public ticket detail',
      runId: publicRun.id,
      status: 'inbox',
      title: 'Public ticket',
    },
  })
  return {
    agentId: agent.id,
    organizationId: organization.id,
    ownerId: owner.id,
    privateTaskId: privateTask.id,
    projectId: project.id,
    publicChannelId: publicChannel.id,
    publicTaskId: publicTask.id,
    sourceAuthorId: sourceAuthor.id,
  }
}

const contextFor = (prisma: PrismaClient, seed: Seed): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { effectiveUserId: seed.ownerId, requestId: randomUUID() },
    actor: { actorId: seed.ownerId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: seed.organizationId, projectId: seed.projectId },
  },
  agentId: seed.agentId,
  // Ticket tools are personal-assistant tools. A shared agent belongs to its
  // bound project channel and must retain that project guard; this owner-run
  // fixture exercises the PA's independent project-read entitlement instead.
  agentKind: 'personal_assistant',
  channel: { id: seed.publicChannelId, organizationId: seed.organizationId, systemChannelType: null },
  ledgerIdentity: null,
  prisma,
  realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
  run: { id: randomUUID(), messageId: randomUUID(), threadId: randomUUID() },
  toolCallId: randomUUID(),
})

runDatabaseTest('ticket tools withhold a private run-linked task from an organisation owner', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: s.organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [s.ownerId, s.sourceAuthorId] } } })
    await prisma.$disconnect()
  })
  const context = contextFor(prisma, s)

  const listed = await runTicketListTool(context, { projectId: s.projectId })
  assert.match(listed.outputPreview, /Public ticket/)
  assert.doesNotMatch(listed.outputPreview, /PRIVATE-TICKET-CANARY/)

  await assert.rejects(
    runTicketReadTool(context, { ticketId: s.privateTaskId }),
    /Ticket not found/,
  )
  const publicRead = await runTicketReadTool(context, { ticketId: s.publicTaskId })
  assert.match(publicRead.outputPreview, /Public ticket detail/)
})
