import { randomUUID } from 'node:crypto'

import { PrismaClient, type Prisma } from '@prisma/client'
import { confirmExecutorAccessChange } from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  ExecutorCapabilityDescriptorSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { applyExecutorAccessChangeEffects } from '../src/executor-access-change-effects.js'
import { prepareStandingPolicy } from '../src/standing-policy-prepare.js'
import { createAgentTrigger } from '../src/trigger-create.js'

/**
 * One organisation with a ticket trigger and the machines its author could
 * give it (docs/standards/ticket-work.md): an author who is a project member
 * and set the trigger up, a colleague on the project, an owner outside it;
 * the Engineering board; a public channel the CTO is bound to; and private
 * executors paired by the author with a reviewed coding-sessions bridge.
 * Every id is fresh, so suites sharing the database never see each other's
 * rows.
 */

export const CODING_FACTS = {
  agents: ['claude'],
  allowedToolCount: 3,
  configDigest: `sha256:${'a'.repeat(64)}`,
  environmentNames: [],
  maxBudgetUsd: { claude: 5 },
  maxLiveSessionsPerOwner: 3,
  mergeCommands: ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'],
  permissionMode: { claude: 'acceptEdits' },
  rootNames: ['nessie', 'web'],
  serverName: 'coding-sessions',
} as const

export const INSTRUCTIONS = {
  general: 'Read the ticket, then have Claude open a pull request and merge it on green.',
  onPickup: 'Comment that you picked it up.',
}

const descriptorOf = (revision: number, digest: string, codingSessions: Record<string, unknown> | null) =>
  ExecutorCapabilityDescriptorSchema.parse({
    ...(codingSessions ? { codingSessions, mcpServers: ['coding-sessions'] } : {}),
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
    localPolicyDigest: digest,
    operationKeys: ['mcp.tools', 'mcp.call'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision,
    sandboxBackend: 'none',
    supervisor: 'service',
  })

export const testPrisma = (): PrismaClient => {
  const url = new URL(process.env.DATABASE_URL as string)
  url.searchParams.set('connection_limit', '4')
  return new PrismaClient({ datasources: { db: { url: url.toString() } } })
}

export const seedStandingPolicyWorld = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const [authorId, colleagueId, ownerId, strangerId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const organization = await prisma.organization.create({ data: { name: `standing-${suffix}` } })
  const organizationId = organization.id
  await prisma.user.createMany({
    data: [
      { displayName: 'Ondrej', email: `author-${suffix}@example.test`, id: authorId },
      { displayName: 'Colleague', email: `colleague-${suffix}@example.test`, id: colleagueId },
      { displayName: 'Owner', email: `owner-${suffix}@example.test`, id: ownerId },
      { displayName: 'Stranger', email: `stranger-${suffix}@example.test`, id: strangerId },
    ],
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, role: 'member', userId: authorId },
      { organizationId, role: 'member', userId: colleagueId },
      { organizationId, role: 'owner', userId: ownerId },
      { organizationId, role: 'member', userId: strangerId },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId } })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, role: 'member', userId: authorId },
      { projectId: project.id, role: 'member', userId: colleagueId },
    ],
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId, position: 0, projectId: project.id },
  })
  const column = async (name: string, category: 'todo' | 'in_progress' | 'review' | 'done', position: number) =>
    (await prisma.boardColumn.create({
      data: { boardId: board.id, category, name, organizationId, position },
      select: { id: true },
    })).id
  const columns = {
    backlog: await column('Backlog', 'todo', 0),
    inProgress: await column('In progress', 'in_progress', 1),
    review: await column('Review', 'review', 2),
    done: await column('Done', 'done', 3),
  }
  const channel = async (label: string) => (await prisma.channel.create({
    data: {
      label, organizationId, projectId: project.id, slug: `${label}-${suffix}`, teamId: team.id, visibility: 'public',
    },
    select: { id: true },
  })).id
  const engId = await channel('eng')
  const opsId = await channel('ops')
  const agent = await prisma.agent.create({
    data: { name: 'CTO', organizationId, ownerUserId: authorId, projectId: project.id },
  })
  for (const channelId of [engId, opsId]) await prisma.agentBinding.create({ data: { agentId: agent.id, channelId } })
  const trigger = await createAgentTrigger(prisma, agent.id, {
    config: { instructions: INSTRUCTIONS, pickup: { columns: [{ name: 'In progress' }] } },
    name: 'Pick up tickets',
    targetChannelId: engId,
    type: 'ticket_changed',
  }, { authorUserId: authorId })
  if (!trigger) throw new Error('The ticket trigger was refused.')

  const executors: string[] = []
  /** A machine; by default private, paired by the author, online, with a reviewed bridge. */
  const machine = async (options: {
    codingSessions?: Record<string, unknown> | null
    label?: string
    pairedBy?: string
    scope?: 'private' | 'organization'
    status?: 'online' | 'offline'
  } = {}): Promise<string> => {
    const pairedBy = options.pairedBy ?? authorId
    const scope = options.scope ?? 'private'
    const executor = await prisma.executor.create({
      data: {
        label: options.label ?? `Machine ${executors.length + 1}`,
        lastSeenAt: new Date(),
        organizationId,
        pairingOwnerUserId: pairedBy,
        profiles: ['workspace_sandbox'],
        scopeKind: scope,
        status: options.status ?? 'online',
        ...(scope === 'private'
          ? { privateAssignments: { create: [{ principalKind: 'user' as const, role: 'admin' as const, userId: pairedBy }] } }
          : {}),
      },
    })
    executors.push(executor.id)
    const descriptor = descriptorOf(1, `sha256:${'1'.repeat(64)}`,
      options.codingSessions === undefined ? { ...CODING_FACTS } : options.codingSessions)
    await prisma.executorCapabilityRevision.create({
      data: {
        descriptor: descriptor as unknown as Prisma.InputJsonValue, executorId: executor.id,
        localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: pairedBy,
        revision: 1, signature: 'reviewed',
      },
    })
    return executor.id
  }
  /** A newer revision of a machine, waiting for its review. */
  const proposeRevision = async (executorId: string, revision: number, configDigest: string) => {
    const descriptor = descriptorOf(revision, `sha256:${String(revision).repeat(64).slice(0, 64)}`,
      { ...CODING_FACTS, configDigest })
    await prisma.executorCapabilityRevision.create({
      data: {
        descriptor: descriptor as unknown as Prisma.InputJsonValue, executorId,
        localPolicyDigest: descriptor.localPolicyDigest, revision, signature: 'proposed',
      },
    })
  }
  const contextFor = (userId: string): AuthorizedActionContext => AuthorizedActionContextSchema.parse({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: userId, actorType: 'user' },
    tenant: { organizationId, teamId: team.id },
  })
  const task = async (title: string) => (await prisma.task.create({
    data: { organizationId, projectId: project.id, status: 'in_progress', title },
    select: { id: true },
  })).id
  const thread = await prisma.thread.create({ data: { channelId: engId }, select: { id: true } })
  const work = (input: {
    executorId?: string | null
    policyId?: string | null
    sessionIds?: string[]
    stateReason?: string | null
    status: string
    taskId: string
  }) => prisma.agentTicketWork.create({
    data: {
      agentId: agent.id, executorId: input.executorId ?? null, organizationId, policyId: input.policyId ?? null,
      projectId: project.id, sessionIds: input.sessionIds ?? [], startedByUserId: colleagueId,
      stateReason: input.stateReason ?? null, status: input.status, taskId: input.taskId, threadId: thread.id,
      triggerId: trigger.id,
    },
  })
  const authorContext = contextFor(authorId)
  /** Prepare with the author's authority, then confirm as the card's Review would, under one fresh verification. */
  const prepare = (input: Record<string, unknown>, actor = authorContext) =>
    prepareStandingPolicy(prisma, actor, { triggerId: trigger.id, ...input })
  const confirm = (prepared: { accessChangeId: string; confirmationToken: string }, actor = authorContext) =>
    confirmExecutorAccessChange(prisma, actor, {
      accessChangeId: prepared.accessChangeId,
      confirmationToken: prepared.confirmationToken,
      freshVerificationSatisfied: true,
    }, (tx, confirmed) => applyExecutorAccessChangeEffects(tx, {
      actorContext: actor, change: confirmed.change, executorId: confirmed.executorId, ledgerSigningConfigured: false,
    }))
  const cleanup = async () => {
    await prisma.agentTicketWork.deleteMany({ where: { organizationId } })
    await prisma.executorCodingSessionCloseRequest.deleteMany({ where: { executorId: { in: executors } } })
    await prisma.executorContinuation.deleteMany({ where: { executorId: { in: executors } } })
    await prisma.executorPrivateAssignment.deleteMany({ where: { executorId: { in: executors } } })
    await prisma.executorAgentOperationGrant.deleteMany({ where: { executorId: { in: executors } } })
    await prisma.executorStandingPolicy.deleteMany({ where: { organizationId } })
    await prisma.executor.deleteMany({ where: { id: { in: executors } } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [authorId, colleagueId, ownerId, strangerId] } } })
  }
  return {
    agentId: agent.id, authorContext, authorId, board: board.id, cleanup, colleagueId, columns, confirm, contextFor,
    engId, machine, opsId, organizationId, ownerId, prepare, projectId: project.id, proposeRevision, strangerId, task,
    teamId: team.id, threadId: thread.id, triggerId: trigger.id, work,
  }
}
export type StandingPolicyWorld = Awaited<ReturnType<typeof seedStandingPolicyWorld>>
