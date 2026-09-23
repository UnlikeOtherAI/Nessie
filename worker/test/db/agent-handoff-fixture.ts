import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { AGENT_DESIGNER_SLUG, globalAgentHomeDmKey } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { deleteThreadQueueJobs } from './support.js'

// The organisation, origin room and running origin agent every `agent_handoff`
// suite starts from, and the tool context that origin run hands the tool.
// Shared by `agent-handoff.test.ts` and `agent-handoff-drain.test.ts`.

export type Seed = {
  agentId: string
  channelId: string
  memberId: string
  organizationId: string
  ownerId: string
  projectId: string
  runId: string
  teamId: string
  threadId: string
}

export const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `handoff-${suffix}` },
  })
  const [owner, member] = await Promise.all([
    prisma.user.create({
      data: { displayName: 'Owner', email: `handoff-owner-${suffix}@example.test` },
    }),
    prisma.user.create({
      data: { displayName: 'Member', email: `handoff-member-${suffix}@example.test` },
    }),
  ])
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `handoff-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `handoff-team-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'ops',
      members: { create: [{ userId: owner.id }, { userId: member.id }] },
      organizationId: organization.id,
      projectId: project.id,
      slug: `handoff-ops-${suffix}`,
      teamId: team.id,
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'general' },
  })
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      name: `Ops agent ${suffix}`,
      organizationId: organization.id,
      role: 'ops',
    },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    memberId: member.id,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    runId: run.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

export const cleanup = async (prisma: PrismaClient, team: Seed): Promise<void> => {
  const designerThreads = await prisma.thread.findMany({
    where: { channel: { organizationId: team.organizationId } },
    select: { id: true },
  })
  for (const thread of designerThreads) {
    await deleteThreadQueueJobs(prisma, thread.id)
  }
  await prisma.organization.deleteMany({ where: { id: team.organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [team.memberId, team.ownerId] } },
  })
}

export const buildContext = (
  prisma: PrismaClient,
  team: Seed,
  options: {
    /** The human doing the asking — the actor. */
    actorUserId?: string
    /** What the run is delegated to act as, which may be somebody else. */
    effectiveUserId?: string
    interactive?: boolean
    unattended?: boolean
    consumed?: { scopeId: string; scopeType: string }[]
  } = {},
): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  consumedSources.addAll(options.consumed ?? [])
  const actorContext = {
    actionContext: {
      ...(options.effectiveUserId ? { effectiveUserId: options.effectiveUserId } : {}),
      requestId: randomUUID(),
    },
    actor: options.unattended
      ? { actorId: team.agentId, actorType: 'agent' as const, roles: ['system'] }
      : {
        actorId: options.actorUserId ?? team.ownerId,
        actorType: 'user' as const,
        roles: ['member'],
      },
    tenant: {
      organizationId: team.organizationId,
      projectId: team.projectId,
      teamId: team.teamId,
    },
  }
  const runContext: RunContext = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: team.agentId,
      model: null,
      name: 'Ops agent',
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [],
    channel: {
      dmKey: null,
      id: team.channelId,
      organizationId: team.organizationId,
      projectId: team.projectId,
      systemChannelType: null,
      teamId: team.teamId,
    },
    consumedSources,
    run: {
      createdAt: new Date(),
      id: team.runId,
      replyPlacement: null,
      threadId: team.threadId,
    },
    task: { id: randomUUID() },
  }

  return {
    actorContext: actorContext as BuiltinToolRuntimeContext['actorContext'],
    agentId: team.agentId,
    agentKind: 'shared',
    channel: {
      id: team.channelId,
      organizationId: team.organizationId as never,
      systemChannelType: null,
    },
    consumedSources,
    ledgerIdentity: null,
    prisma,
    realtimeTransport: {
      publishWs: async () => undefined,
    } as BuiltinToolRuntimeContext['realtimeTransport'],
    run: {
      id: team.runId,
      interactive: options.interactive ?? true,
      messageId: randomUUID(),
      threadId: team.threadId,
    },
    runContext,
    toolCallId: randomUUID(),
  }
}

export const designerHome = async (
  prisma: PrismaClient,
  team: Seed,
  userId: string,
) =>
  prisma.channel.findUniqueOrThrow({
    where: {
      dmKey: globalAgentHomeDmKey({
        organizationId: team.organizationId,
        slug: AGENT_DESIGNER_SLUG,
        userId,
      }),
    },
    select: { id: true, threads: { select: { id: true } } },
  })
