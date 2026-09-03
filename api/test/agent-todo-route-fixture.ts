import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { isAgentAccessibleToActor } from '@nessie/team-admin'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerAgentTodoRoutes } from '../src/routes/agent-todos.js'

export type AgentTodoRouteSeed = {
  agentId: string
  channelId: string
  disabledAgentId: string
  memberId: string
  organizationId: string
  otherAgentId: string
  outsiderId: string
  ownerId: string
  peerId: string
  projectId: string
  teamId: string
  threadId: string
  unboundChannelId: string
}

export type TodoActor = 'member' | 'outsider' | 'owner' | 'peer'

const actorUserId = (seed: AgentTodoRouteSeed, actor: TodoActor): string => ({
  member: seed.memberId,
  outsider: seed.outsiderId,
  owner: seed.ownerId,
  peer: seed.peerId,
})[actor]

export const actorContextFor = (
  seed: AgentTodoRouteSeed,
  actor: TodoActor,
): AuthorizedActionContext => ({
  actionContext: { requestId: `agent-todo-${actor}-${randomUUID()}` },
  actor: {
    actorId: actorUserId(seed, actor),
    actorType: 'user',
    roles: [actor === 'owner' ? 'owner' : 'member'],
  },
  tenant: {
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    teamId: seed.teamId,
  },
})

export const seedAgentTodoRoutes = async (
  prisma: PrismaClient,
): Promise<AgentTodoRouteSeed> => {
  const seed: AgentTodoRouteSeed = {
    agentId: randomUUID(),
    channelId: randomUUID(),
    disabledAgentId: randomUUID(),
    memberId: randomUUID(),
    organizationId: randomUUID(),
    otherAgentId: randomUUID(),
    outsiderId: randomUUID(),
    ownerId: randomUUID(),
    peerId: randomUUID(),
    projectId: randomUUID(),
    teamId: randomUUID(),
    threadId: randomUUID(),
    unboundChannelId: randomUUID(),
  }

  await prisma.organization.create({
    data: { id: seed.organizationId, name: `agent-todo-${seed.organizationId}` },
  })
  await prisma.user.createMany({
    data: [seed.ownerId, seed.memberId, seed.peerId, seed.outsiderId].map(
      (id, index) => ({
        displayName: `Agent todo user ${index}`,
        email: `agent-todo-${id}@example.test`,
        id,
      }),
    ),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: seed.organizationId, role: 'owner', userId: seed.ownerId },
      { organizationId: seed.organizationId, role: 'member', userId: seed.memberId },
      { organizationId: seed.organizationId, role: 'member', userId: seed.peerId },
      { organizationId: seed.organizationId, role: 'member', userId: seed.outsiderId },
    ],
  })
  await prisma.project.create({
    data: {
      id: seed.projectId,
      name: 'Agent todo project',
      organizationId: seed.organizationId,
    },
  })
  await prisma.team.create({
    data: { id: seed.teamId, name: 'Agent todo team', projectId: seed.projectId },
  })
  await prisma.channel.create({
    data: {
      id: seed.channelId,
      label: 'agent-todo-channel',
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      slug: `agent-todo-${seed.channelId.slice(0, 8)}`,
      teamId: seed.teamId,
      visibility: 'private',
    },
  })
  await prisma.channelMember.createMany({
    data: [seed.ownerId, seed.memberId, seed.peerId].map((userId) => ({
      channelId: seed.channelId,
      userId,
    })),
  })
  await prisma.channel.create({
    data: {
      id: seed.unboundChannelId,
      label: 'unbound-agent-todo-channel',
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      slug: `unbound-agent-todo-${seed.unboundChannelId.slice(0, 8)}`,
      teamId: seed.teamId,
      visibility: 'private',
      members: { create: { userId: seed.memberId } },
    },
  })
  await prisma.thread.create({
    data: { channelId: seed.channelId, id: seed.threadId, title: 'Agent todo thread' },
  })
  await prisma.agent.createMany({
    data: [
      {
        id: seed.agentId,
        name: 'Checklist agent',
        organizationId: seed.organizationId,
        ownerUserId: seed.ownerId,
        projectId: seed.projectId,
        teamId: seed.teamId,
        todosEnabled: true,
      },
      {
        id: seed.otherAgentId,
        name: 'Other checklist agent',
        organizationId: seed.organizationId,
        projectId: seed.projectId,
        teamId: seed.teamId,
        todosEnabled: true,
      },
      {
        id: seed.disabledAgentId,
        name: 'Disabled checklist agent',
        organizationId: seed.organizationId,
        projectId: seed.projectId,
        teamId: seed.teamId,
        todosEnabled: false,
      },
    ],
  })
  await prisma.agentBinding.createMany({
    data: [seed.agentId, seed.otherAgentId, seed.disabledAgentId].map(
      (agentId) => ({ agentId, channelId: seed.channelId }),
    ),
  })
  return seed
}

export const cleanupAgentTodoRoutes = async (
  prisma: PrismaClient,
  seed: AgentTodoRouteSeed,
): Promise<void> => {
  await prisma.agentTodo.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.agentTodoTemplate.deleteMany({
    where: { organizationId: seed.organizationId },
  })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
  await prisma.user.deleteMany({
    where: {
      id: { in: [seed.ownerId, seed.memberId, seed.peerId, seed.outsiderId] },
    },
  })
}

export const createAgentTodoRouteApp = (
  prisma: PrismaClient,
  seed: AgentTodoRouteSeed,
  actor: TodoActor,
): FastifyInstance => {
  const actorContext = actorContextFor(seed, actor)
  const app = Fastify({ logger: false })
  registerAgentTodoRoutes(app, {
    createAgentVisibilityScope: (context) => ({
      includeAllOrgChannels: context.actor.roles?.includes('owner') ?? false,
      organizationId: context.tenant.organizationId,
      userId: context.actor.actorId,
    }),
    isAgentAccessibleToActor: (context, agentId) =>
      isAgentAccessibleToActor(prisma, context, agentId),
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => actorContext,
    requireOwner: (context, reply) => {
      if (context.actor.roles?.includes('owner')) return true
      void reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Owner access required' },
      })
      return false
    },
  } as unknown as Parameters<typeof registerAgentTodoRoutes>[1])
  return app
}

export const activeTemplatePayload = {
  description: 'A two-step operational checklist.',
  name: 'Release checklist',
  status: 'active',
  steps: [
    {
      instructions: 'Collect the release evidence.',
      key: 'collect-evidence',
      title: 'Collect evidence',
    },
    {
      instructions: 'Publish the verified result.',
      key: 'publish-result',
      title: 'Publish result',
    },
  ],
} as const
