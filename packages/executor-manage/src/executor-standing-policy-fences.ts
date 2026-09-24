import type { Prisma } from '@prisma/client'
import type { ExecutorStandingPolicyEndedReason } from '@nessie/schemas'

import { endStandingPolicyInTransaction, type StandingPolicyActor } from './executor-standing-policy-lifecycle.js'

/**
 * The fences that end a standing policy, each in the transaction of the
 * change that is its reason (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md
 * → "Fences"; docs/standards/ticket-work-machine-access.md). They sit where
 * the conversation-lease fences already sit — the executor paused, drained or
 * revoked, a person's or an agent's access withdrawn, a review narrowing what
 * the machine offers — and where the board-side fences are: the author or
 * the agent losing the project, its channel, board or columns.
 *
 * Ending a policy cancels its live records (`machine_access_ended`) and
 * writes session-scoped closes for every session they started, named by the
 * ticket's own owner context (`policy_ended`), because an owner-wide close
 * keyed without a context — the one an agent's withdrawn access writes —
 * never reaches a ticket's sessions. Each writes `executor.policy.ended` with
 * the reason and who did it. A card still waiting for confirmation ends too:
 * it could otherwise be confirmed over the change that ended the policy.
 */

export const endStandingPoliciesInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: StandingPolicyActor
    reason: ExecutorStandingPolicyEndedReason
    where: Prisma.ExecutorStandingPolicyWhereInput
  },
): Promise<string[]> => {
  const policies = await tx.executorStandingPolicy.findMany({
    where: { ...input.where, status: { not: 'ended' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  const ended: string[] = []
  for (const policy of policies) {
    if (await endStandingPolicyInTransaction(tx, { actor: input.actor, policyId: policy.id, reason: input.reason })) {
      ended.push(policy.id)
    }
  }
  return ended
}

/**
 * A machine's own fences: every policy whose pool names it, or only the ones
 * of one agent (its access withdrawn) or of one author (their place on the
 * roster removed).
 */
export const endStandingPoliciesForExecutorInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: StandingPolicyActor
    executorId: string
    only?: { agentId: string } | { actorUserId: string }
    reason: ExecutorStandingPolicyEndedReason
  },
): Promise<string[]> => endStandingPoliciesInTransaction(tx, {
  actor: input.actor,
  reason: input.reason,
  where: {
    executors: { some: { executorId: input.executorId } },
    ...(input.only && 'agentId' in input.only ? { agentId: input.only.agentId } : {}),
    ...(input.only && 'actorUserId' in input.only ? { authorUserId: input.only.actorUserId } : {}),
  },
})
