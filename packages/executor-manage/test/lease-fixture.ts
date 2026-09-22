import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema,
  ExecutorCapabilityDescriptorSchema,
  PERSON_MESSAGE_AUTHORSHIP,
  RunExecuteJobPayloadSchema,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import {
  bindExecutorCandidateBundleInTransaction,
  createExecutorConversationLeaseInTransaction,
  ensureExecutorLogicalTools,
  EXECUTOR_LOCAL_APPS_OPERATION_KEYS,
  resolveExecutorAvailabilityCandidates,
} from '../src/index.js'

/**
 * One organisation with an online, organisation-scoped executor whose reviewed
 * policy offers the local-apps pair, an agent granted it and bound to one
 * channel, and three people: the holder who launches, another member, and an
 * owner who manages the executor. Every id is fresh, so suites sharing the
 * database never see each other's rows.
 */
export type LeaseWorld = {
  adminContext: AuthorizedActionContext
  adminId: string
  agentId: string
  channelId: string
  cleanup: () => Promise<void>
  contextFor: (userId: string, extra?: Partial<AuthorizedActionContext['actionContext']>) => AuthorizedActionContext
  executorId: string
  holderContext: AuthorizedActionContext
  holderId: string
  memberContext: AuthorizedActionContext
  memberId: string
  organizationId: string
  prisma: PrismaClient
  threadId: string
}

export const LOCAL_APPS = [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS]

export const localAppsDescriptor = (revision: number, operationKeys: string[] = LOCAL_APPS) =>
  ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision, profiles: ['workspace_sandbox'], operationKeys,
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${String(revision).repeat(64).slice(0, 64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })

export const seedLeaseWorld = async (
  prisma: PrismaClient,
  options: { agentConversation?: boolean } = {},
): Promise<LeaseWorld> => {
  const organizationId = randomUUID()
  const [holderId, memberId, adminId] = [randomUUID(), randomUUID(), randomUUID()]
  const agentId = randomUUID()
  const executorId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `lease ${organizationId}` } })
  await prisma.user.createMany({
    data: [holderId, memberId, adminId].map((id) => ({ id, email: `${id}@example.test`, displayName: id.slice(0, 8) })),
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, userId: holderId, role: 'member' },
      { organizationId, userId: memberId, role: 'member' },
      { organizationId, userId: adminId, role: 'owner' },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: { label: 'c', slug: `c-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id },
  })
  const tools = await ensureExecutorLogicalTools(prisma, organizationId)
  await prisma.agent.create({
    data: {
      id: agentId, name: 'CTO', organizationId,
      toolPolicy: Object.fromEntries(LOCAL_APPS.map((key) => [tools.get(key as never)!, true])),
    },
  })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, ...(options.agentConversation ? { agentId, startedByUserId: holderId } : {}) },
  })
  await prisma.executor.create({
    data: {
      id: executorId, organizationId, pairingOwnerUserId: adminId, label: 'Minis', scopeKind: 'organization',
      status: 'online', lastSeenAt: new Date(), profiles: ['workspace_sandbox'],
    },
  })
  const descriptor = localAppsDescriptor(1)
  await prisma.executorCapabilityRevision.create({
    data: {
      executorId, revision: 1, descriptor, signature: 'reviewed-test-descriptor',
      localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: adminId,
    },
  })
  await prisma.executorAgentOperationGrant.createMany({
    data: LOCAL_APPS.map((operationKey) => ({
      agentId, authorizationRevision: 1, executorId, operationKey, state: 'allowed' as const, updatedByUserId: adminId,
    })),
  })
  const contextFor = (
    userId: string,
    extra: Partial<AuthorizedActionContext['actionContext']> = {},
  ): AuthorizedActionContext => AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID(), ...extra },
  })
  const cleanup = async () => {
    await prisma.executorCommand.deleteMany({ where: { binding: { executorId } } })
    await prisma.queueJob.deleteMany({ where: { idempotencyKey: { startsWith: `lease-test:${executorId}` } } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.executorConversationLease.deleteMany({ where: { organizationId } })
    await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId } })
    await prisma.executor.deleteMany({ where: { id: executorId } })
    await prisma.message.deleteMany({ where: { threadId: thread.id } })
    await prisma.thread.deleteMany({ where: { channelId: channel.id } })
    await prisma.channel.deleteMany({ where: { id: channel.id } })
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [holderId, memberId, adminId] } } })
  }
  return {
    adminContext: contextFor(adminId), adminId, agentId, channelId: channel.id, cleanup, contextFor,
    executorId, holderContext: contextFor(holderId), holderId, memberContext: contextFor(memberId), memberId,
    organizationId, prisma, threadId: thread.id,
  }
}

/** The launch as `launchExecutorRun` performs it: message, run, bundle, lease. */
export const launchLocalApps = async (world: LeaseWorld) => {
  const { prisma } = world
  const message = await prisma.message.create({
    data: {
      content: 'Open the project in Kelpie', metadata: { executorLaunch: { operationKeys: LOCAL_APPS } },
      role: 'user', threadId: world.threadId, userId: world.holderId,
    },
  })
  const run = await prisma.run.create({
    data: { agentId: world.agentId, status: 'completed', threadId: world.threadId, triggerMessageId: message.id },
  })
  const availability = await resolveExecutorAvailabilityCandidates(prisma, world.holderContext, {
    agentId: world.agentId, operationKeys: LOCAL_APPS as never,
  })
  const candidate = availability.candidates[0]
  if (!candidate) throw new Error(`No local-apps candidate: ${JSON.stringify(availability.explanations)}`)
  return prisma.$transaction(async (tx) => {
    const bindings = await bindExecutorCandidateBundleInTransaction(tx, {
      actorUserId: world.holderId, candidateHandle: candidate.handle,
      operationKeys: LOCAL_APPS as never, runId: run.id,
    })
    const lease = await createExecutorConversationLeaseInTransaction(tx, {
      actorContext: world.holderContext, agentId: world.agentId,
      bindingIds: bindings.map((binding) => binding.bindingId), executorId: world.executorId,
      launchRunId: run.id, rootMessageId: message.id, threadId: world.threadId,
    })
    return { bindings, lease, message, run }
  })
}

export const postMessage = (
  world: LeaseWorld,
  input: {
    authorship?: boolean
    metadata?: Record<string, unknown>
    role?: 'user' | 'system'
    rootMessageId?: string
    userId?: string | null
  },
) => world.prisma.message.create({
  data: {
    content: 'And now check the pricing page',
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.authorship === false ? {} : { authorship: PERSON_MESSAGE_AUTHORSHIP }),
    } as Prisma.InputJsonValue,
    role: input.role ?? 'user',
    threadId: world.threadId,
    ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
    ...(input.userId === null ? {} : { userId: input.userId ?? world.holderId }),
  },
})

export const createRun = (
  world: LeaseWorld,
  input: { continuationOfRunId?: string; restartOfRunId?: string; triggerMessageId: string },
) => world.prisma.run.create({
  data: { agentId: world.agentId, status: 'running', threadId: world.threadId, ...input },
})

export const jobFor = (
  world: LeaseWorld,
  input: {
    actorContext?: AuthorizedActionContext
    batchMessageIds?: string[]
    interactive?: boolean
    messageId: string
    runId: string
  },
): RunExecuteJobPayload => RunExecuteJobPayloadSchema.parse({
  actorContext: input.actorContext ?? world.contextFor(world.holderId),
  agentId: world.agentId,
  ...(input.batchMessageIds ? { batchMessageIds: input.batchMessageIds } : {}),
  interactive: input.interactive ?? true,
  messageId: input.messageId,
  runId: input.runId,
  taskId: randomUUID(),
  threadId: world.threadId,
})

export const leaseRow = (world: LeaseWorld, id: string) =>
  world.prisma.executorConversationLease.findUniqueOrThrow({ where: { id } })

export const auditRows = (world: LeaseWorld, action: string) => world.prisma.auditLog.findMany({
  where: { action, organizationId: world.organizationId }, orderBy: { createdAt: 'asc' },
})
