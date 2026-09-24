import type { Prisma, PrismaClient } from '@prisma/client'
import {
  ExecutorStandingPolicyStatusSchema,
  ExecutorStandingPolicySuspendedReasonSchema,
  type ExecutorStandingPolicyRow,
} from '@nessie/schemas'

import { canManageExecutor, resolveExecutorHumanAccess } from './executor-access.js'
import { endStandingPolicyInTransaction } from './executor-standing-policy-lifecycle.js'

/**
 * What the executor page reads of standing machine access, and the End a
 * person presses (docs/standards/ticket-work-machine-access.md → "What the
 * screens show"): the policies whose pool names a machine, for the people who
 * administer it, and ending one — by its author or by an administrator of one
 * of its machines — with `executor.policy.ended` naming them.
 */

type Client = PrismaClient | Prisma.TransactionClient

/** Which of these machines the person administers, by the machine page's own rule. */
export const executorsAdministeredBy = async (
  client: Client,
  input: { executorIds: readonly string[]; organizationId: string; userId: string },
): Promise<Set<string>> => {
  const executors = await client.executor.findMany({
    where: { id: { in: [...input.executorIds] }, organizationId: input.organizationId, removedAt: null },
    select: { id: true, projectId: true, scopeKind: true },
  })
  const administered = new Set<string>()
  for (const executor of executors) {
    const access = await resolveExecutorHumanAccess(client, input.organizationId, input.userId, executor)
    if (canManageExecutor(executor, access)) administered.add(executor.id)
  }
  return administered
}

/** Whether this person may end the policy: its author, or an administrator of one of its machines. */
export const canEndStandingPolicy = async (
  client: Client,
  input: { organizationId: string; policyId: string; userId: string },
): Promise<boolean> => {
  const policy = await client.executorStandingPolicy.findFirst({
    where: { id: input.policyId, organizationId: input.organizationId },
    select: { authorUserId: true, executors: { select: { executorId: true } } },
  })
  if (!policy) return false
  if (policy.authorUserId === input.userId) return true
  const administered = await executorsAdministeredBy(client, {
    executorIds: policy.executors.map((row) => row.executorId),
    organizationId: input.organizationId,
    userId: input.userId,
  })
  return administered.size > 0
}

/**
 * A person's End: the policy ends (`person`), its live records are cancelled
 * and their sessions closed, in one transaction. `not_found` for a policy
 * this person may not end — a stranger learns nothing of it.
 */
export const endStandingPolicyByPerson = async (
  prisma: PrismaClient,
  input: { organizationId: string; policyId: string; requestId?: string; userId: string },
): Promise<'ended' | 'already_ended' | 'not_found'> => prisma.$transaction(async (tx) => {
  if (!await canEndStandingPolicy(tx, input)) return 'not_found'
  const ended = await endStandingPolicyInTransaction(tx, {
    actor: { userId: input.userId, ...(input.requestId ? { requestId: input.requestId } : {}) },
    policyId: input.policyId,
    reason: 'person',
  })
  return ended ? 'ended' : 'already_ended'
})

/**
 * Every policy not yet ended whose pool names this machine, for a person who
 * administers it (the caller checks that). The trigger and agent are named as
 * the machine page names its other holders; the author always is.
 */
export const listExecutorStandingPolicies = async (
  client: Client,
  input: { executorId: string; organizationId: string; userId: string },
): Promise<ExecutorStandingPolicyRow[]> => {
  const policies = await client.executorStandingPolicy.findMany({
    where: {
      executors: { some: { executorId: input.executorId } },
      organizationId: input.organizationId,
      status: { not: 'ended' },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      agent: { select: { name: true } },
      author: { select: { displayName: true } },
      authorUserId: true,
      confirmedAt: true,
      createdAt: true,
      id: true,
      status: true,
      suspendedReason: true,
      trigger: { select: { id: true, name: true } },
      _count: { select: { ticketWork: { where: { executorId: input.executorId, status: 'active' } } } },
    },
  })
  return policies.map((policy) => {
    const suspended = ExecutorStandingPolicySuspendedReasonSchema.safeParse(policy.suspendedReason)
    return {
      activeTickets: policy._count.ticketWork,
      agentName: policy.agent.name || null,
      authorName: policy.author.displayName,
      confirmedAt: policy.confirmedAt?.toISOString() ?? null,
      createdAt: policy.createdAt.toISOString(),
      id: policy.id,
      status: ExecutorStandingPolicyStatusSchema.parse(policy.status),
      suspendedReason: suspended.success ? suspended.data : null,
      trigger: policy.trigger ? { id: policy.trigger.id, name: policy.trigger.name || 'Untitled trigger' } : null,
      // Whoever reads this panel administers the machine, so they may end what runs on it.
      viewerCanEnd: true,
    }
  })
}
