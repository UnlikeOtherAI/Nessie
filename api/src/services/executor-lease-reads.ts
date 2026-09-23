import type { PrismaClient } from '@prisma/client'
import {
  ExecutorError,
  EXECUTOR_ERROR_CODES,
  executorLeaseExpiresAt,
  getExecutorForManagement,
} from '@nessie/executor-manage'
import { buildAccessibleThreadWhere, buildAgentEntitlementWhere } from '@nessie/team-admin'
import type {
  AuthorizedActionContext,
  ExecutorConversationLeaseRecord,
  ExecutorMachineLeaseRecord,
} from '@nessie/schemas'

/**
 * The two readings of executor conversation leases
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §4).
 * "Live" is the one liveness rule, applied in the query: not ended, and inside
 * both the idle and the absolute window.
 */

const liveAt = (now: Date) => ({
  absoluteExpiresAt: { gt: now },
  endedAt: null,
  idleExpiresAt: { gt: now },
})

/** Enough for any one person in any one conversation; there is no paging. */
const OWN_LEASE_LIMIT = 20
/** Bounded like the Activity tab beside it; the panel says when it is full. */
export const MACHINE_LEASE_LIMIT = 50

/**
 * The viewer's own live leases in one conversation — and only theirs. Anybody
 * else asking about the same thread is answered with an empty list, never a
 * refusal, so the reply cannot even confirm that a lease or a machine exists
 * there. That is what keeps a private executor's name out of a shared room.
 */
export const listOwnExecutorConversationLeases = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  input: { threadId: string },
  now = new Date(),
): Promise<ExecutorConversationLeaseRecord[]> => {
  if (actor.actor.actorType !== 'user') return []
  const rows = await prisma.executorConversationLease.findMany({
    where: {
      actorUserId: actor.actor.actorId,
      organizationId: actor.tenant.organizationId,
      threadId: input.threadId,
      ...liveAt(now),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      absoluteExpiresAt: true, agentId: true, createdAt: true, endedAt: true, executor: { select: { label: true } },
      id: true, idleExpiresAt: true, rootMessageId: true, threadId: true,
    },
    take: OWN_LEASE_LIMIT,
  })
  return rows.map((row) => ({
    agentId: row.agentId,
    executorLabel: row.executor.label,
    expiresAt: executorLeaseExpiresAt(row).toISOString(),
    id: row.id,
    launchedAt: row.createdAt.toISOString(),
    rootMessageId: row.rootMessageId,
    threadId: row.threadId,
  }))
}

/**
 * Every live lease on one executor, for the people who may manage it. Anyone
 * else is "not found", exactly as the machine's other management reads are.
 *
 * Managing the machine does not widen what else the reader may see: an agent
 * is named only when the ordinary agent entitlement would show it to them (the
 * Agents tab's own rule), and a conversation only when they could open it —
 * the participant rule, not an owner's all-channels view, because a DM a
 * person holds a lease in is theirs.
 */
export const listExecutorMachineLeases = async (
  prisma: PrismaClient,
  actor: AuthorizedActionContext,
  executorId: string,
  now = new Date(),
): Promise<ExecutorMachineLeaseRecord[]> => {
  const managed = await getExecutorForManagement(prisma, actor, executorId)
  if (!managed) throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  const organizationId = actor.tenant.organizationId
  const userId = actor.actor.actorId
  const rows = await prisma.executorConversationLease.findMany({
    where: { executorId, organizationId, ...liveAt(now) },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      absoluteExpiresAt: true, actorUserId: true, agentId: true, createdAt: true, endedAt: true, id: true,
      idleExpiresAt: true, lastUsedAt: true,
      thread: { select: { channel: { select: { id: true, label: true } }, id: true, title: true } },
    },
    take: MACHINE_LEASE_LIMIT,
  })
  if (rows.length === 0) return []
  const [namedAgents, readableThreads] = await Promise.all([
    prisma.agent.findMany({
      where: {
        AND: [
          { id: { in: [...new Set(rows.map((row) => row.agentId))] }, deletedAt: null },
          buildAgentEntitlementWhere({
            includeSystemManaged: true,
            includeUnbound: managed.access.organizationRole === 'owner' || managed.access.organizationRole === 'admin',
            organizationId,
            userId,
          }),
        ],
      },
      select: { id: true, name: true },
    }),
    prisma.thread.findMany({
      where: {
        AND: [
          { id: { in: [...new Set(rows.map((row) => row.thread.id))] } },
          buildAccessibleThreadWhere({ includeAllOrgChannels: false, organizationId, userId }),
        ],
      },
      select: { id: true },
    }),
  ])
  const agentNames = new Map(namedAgents.map((agent) => [agent.id, agent.name]))
  const readable = new Set(readableThreads.map((thread) => thread.id))
  return rows.map((row) => ({
    agent: { id: row.agentId, name: agentNames.get(row.agentId) ?? null },
    conversation: {
      channelId: row.thread.channel.id,
      label: readable.has(row.thread.id)
        ? row.thread.title ? `${row.thread.channel.label} · ${row.thread.title}` : row.thread.channel.label
        : null,
      threadId: row.thread.id,
    },
    expiresAt: executorLeaseExpiresAt(row).toISOString(),
    holderUserId: row.actorUserId,
    id: row.id,
    lastUsedAt: row.lastUsedAt.toISOString(),
    launchedAt: row.createdAt.toISOString(),
  }))
}
