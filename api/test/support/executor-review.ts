import { randomUUID } from 'node:crypto'
import type test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { prepareExecutorAccessChange, type ExecutorAccessChange } from '@nessie/executor-manage'
import { AuthorizedActionContextSchema, type AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'
import { createRequestHelpers } from '../../src/lib/request-helpers.js'
import { registerAgentCardRoutes } from '../../src/routes/agent-cards.js'
import type { RouteDeps } from '../../src/routes/types.js'

export const REVIEW_CARD = {
  schemaVersion: 1,
  title: 'Confirm an executor change',
  subtitle: 'Pause this executor',
  blocks: [{ type: 'text', markdown: 'Review opens exactly what changes.' }],
  actions: [{ key: 'review', label: 'Review', style: 'primary', submits: true }],
}

export type Seed = {
  actor: AuthorizedActionContext
  agentId: string
  channelId: string
  executorId: string
  organizationId: string
  otherUserId: string
  runId: string
  threadId: string
  userId: string
}

export const actorFor = (userId: string, organizationId: string): AuthorizedActionContext =>
  AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId },
  })

const seed = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `executor-review-${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `review-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `executor-review-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'standard',
      visibility: 'protected',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'main' } })
  const agent = await prisma.agent.create({
    data: { name: `designer-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const [user, other] = await Promise.all(['owner', 'bystander'].map((name) => prisma.user.create({
    data: { displayName: name, email: `executor-review-${name}-${suffix}@example.test` },
  })))
  await prisma.organizationMember.createMany({
    data: [user!, other!].map((person) => ({ organizationId: organization.id, role: 'member' as const, userId: person.id })),
  })
  await prisma.channelMember.createMany({
    data: [user!, other!].map((person) => ({ channelId: channel.id, userId: person.id })),
  })
  const run = await prisma.run.create({ data: { agentId: agent.id, status: 'completed', threadId: thread.id } })
  const executor = await prisma.executor.create({
    data: {
      label: 'Studio Mac',
      lastSeenAt: new Date(),
      organizationId: organization.id,
      pairingOwnerUserId: user!.id,
      privateAssignments: { create: { principalKind: 'user', role: 'admin', userId: user!.id } },
      profiles: ['workspace_sandbox'],
      scopeKind: 'private',
      status: 'online',
    },
  })
  return {
    actor: actorFor(user!.id, organization.id),
    agentId: agent.id,
    channelId: channel.id,
    executorId: executor.id,
    organizationId: organization.id,
    otherUserId: other!.id,
    runId: run.id,
    threadId: thread.id,
    userId: user!.id,
  }
}

/** What the prepare tool writes: a card that knows only the change's id. */
export const prepareWithCard = async (
  prisma: PrismaClient,
  s: Seed,
  change: ExecutorAccessChange,
  respondentUserIds: string[] = [s.userId],
) => {
  const prepared = await prepareExecutorAccessChange(prisma, s.actor, { change, executorId: s.executorId })
  const message = await prisma.message.create({
    data: { agentId: s.agentId, content: 'Confirm an executor change', role: 'assistant', threadId: s.threadId },
  })
  const card = await prisma.agentCard.create({
    data: {
      agentId: s.agentId,
      channelId: s.channelId,
      executorAccessChangeId: prepared.accessChangeId,
      expiresAt: prepared.expiresAt,
      messageId: message.id,
      organizationId: s.organizationId,
      respondentUserIds,
      runId: s.runId,
      spec: REVIEW_CARD,
      threadId: s.threadId,
    },
  })
  return { cardId: card.id, prepared }
}

/** A pending workspace promotion (an `invocation` continuation) and its review card. */
export const promotionWithCard = async (prisma: PrismaClient, s: Seed) => {
  const promotion = await prisma.executorContinuation.create({
    data: {
      actorUserId: s.userId,
      confirmationTokenHash: `prepare-time-${randomUUID()}`,
      executorId: s.executorId,
      expiresAt: new Date(Date.now() + 600_000),
      subject: 'invocation',
      subjectDigest: 'sha256:test',
    },
  })
  const message = await prisma.message.create({
    data: { agentId: s.agentId, content: 'Confirm a workspace promotion', role: 'assistant', threadId: s.threadId },
  })
  const card = await prisma.agentCard.create({
    data: {
      agentId: s.agentId,
      channelId: s.channelId,
      executorWorkspacePromotionId: promotion.id,
      expiresAt: promotion.expiresAt,
      messageId: message.id,
      organizationId: s.organizationId,
      respondentUserIds: [s.userId],
      runId: s.runId,
      spec: { ...REVIEW_CARD, title: 'Confirm a workspace promotion' },
      threadId: s.threadId,
    },
  })
  return { cardId: card.id, promotion, promotionId: promotion.id }
}

export type Published = { data: Record<string, unknown>; event: string; scopes: unknown[] }

/** The realtime and actor deps every route here needs, recording what is published. */
export const routeDeps = (prisma: PrismaClient, s: Seed, userId: string, published: Published[]) => ({
  buildChannelRealtimeScopes: createRequestHelpers(prisma).buildChannelRealtimeScopes,
  prisma,
  realtimeHub: {
    publishWs: async (scopes: unknown[], input: { data: Record<string, unknown>; event: string }) => {
      published.push({ data: input.data, event: input.event, scopes })
      return { ...input, ts: new Date().toISOString(), type: 'event' }
    },
  },
  requireActorContext: () => actorFor(userId, s.organizationId),
  requireUserActor: () => true,
})

export const press = async (prisma: PrismaClient, s: Seed, cardId: string, userId = s.userId, published: Published[] = [], actionKey = 'review') => {
  const app = Fastify()
  registerAgentCardRoutes(app, {
    ...routeDeps(prisma, s, userId, published),
    dashboardCredentials: {},
    mcpSecretStore: {},
    messageMemoryCaptureConfig: null,
  } as unknown as RouteDeps & { dashboardCredentials: unknown })
  const response = await app.inject({
    method: 'POST',
    payload: { actionKey },
    url: `/api/agent-cards/${cardId}/respond`,
  })
  await app.close()
  return response
}

export const withSeed = async (
  t: test.TestContext,
  run: (prisma: PrismaClient, s: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.executor.deleteMany({ where: { organization: { name: `executor-review-${suffix}` } } })
    await prisma.organization.deleteMany({ where: { name: `executor-review-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.$disconnect()
  })
  await run(prisma, await seed(prisma, suffix))
}

