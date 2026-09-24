import type { Prisma } from '@prisma/client'
import { endStandingPoliciesInTransaction, type StandingPolicyActor } from '@nessie/executor-manage'

import { canMemberEditProjectBoards } from './resource-authority.js'

/**
 * The board-side fences that end a standing policy, each in the transaction
 * of its change (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md
 * → "Fences"; docs/standards/ticket-work-machine-access.md). The machine-side
 * ones — pause, revoke, access withdrawn, a narrowing review — are
 * `@nessie/executor-manage`'s; these are what the author agreed to losing its
 * shape on the board's side:
 *
 * - the author no longer able to edit the board (`author_lost_access`) or
 *   deactivated (`author_deactivated`);
 * - the agent unbound from the target channel (`agent_unbound`);
 * - the target channel archived, deleted or made non-public
 *   (`target_channel_unavailable`): the audience the author agreed to is no
 *   longer the one that reads the work;
 * - the project, the board or a start-work column gone (`scope_archived`).
 *
 * A card still out for confirmation ends too, so it can never be confirmed
 * over the change that ended its policy.
 */

type Actor = StandingPolicyActor

const nobody: Actor = { userId: null }

/**
 * Every policy this person authored in the organisation whose board they can
 * no longer edit — asked again, now, by the rule that decides who starts work
 * — or all of them when they were deactivated.
 */
export const endStandingPoliciesForAuthorInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actor?: Actor; deactivated?: boolean; organizationId: string; userId: string },
): Promise<string[]> => {
  const actor = input.actor ?? nobody
  if (input.deactivated) {
    return endStandingPoliciesInTransaction(tx, {
      actor, reason: 'author_deactivated',
      where: { authorUserId: input.userId, organizationId: input.organizationId },
    })
  }
  const policies = await tx.executorStandingPolicy.findMany({
    where: { authorUserId: input.userId, organizationId: input.organizationId, status: { not: 'ended' } },
    select: { id: true, trigger: { select: { scopeProjectId: true } } },
  })
  const lost: string[] = []
  for (const policy of policies) {
    const projectId = policy.trigger?.scopeProjectId
    if (projectId && await canMemberEditProjectBoards(tx, {
      organizationId: input.organizationId, projectId, userId: input.userId,
    })) continue
    lost.push(policy.id)
  }
  if (lost.length === 0) return []
  return endStandingPoliciesInTransaction(tx, { actor, reason: 'author_lost_access', where: { id: { in: lost } } })
}

/** The agent unbound from a channel: every policy whose trigger targets it with that agent. */
export const endStandingPoliciesForAgentUnboundInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actor?: Actor; agentId: string; channelId: string },
): Promise<string[]> => endStandingPoliciesInTransaction(tx, {
  actor: input.actor ?? nobody,
  reason: 'agent_unbound',
  where: { agentId: input.agentId, trigger: { targetChannelId: input.channelId } },
})

/** The target channel archived, deleted or made non-public. */
export const endStandingPoliciesForChannelInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actor?: Actor; channelId: string },
): Promise<string[]> => endStandingPoliciesInTransaction(tx, {
  actor: input.actor ?? nobody,
  reason: 'target_channel_unavailable',
  where: { trigger: { targetChannelId: input.channelId } },
})

/**
 * The project, a board or a start-work column gone. Checked before the delete
 * it belongs to: the trigger's scope columns are `SET NULL` with the row.
 */
export const endStandingPoliciesForScopeInTransaction = async (
  tx: Prisma.TransactionClient,
  input: { actor?: Actor } & ({ projectId: string } | { boardId: string } | { columnId: string }),
): Promise<string[]> => endStandingPoliciesInTransaction(tx, {
  actor: input.actor ?? nobody,
  reason: 'scope_archived',
  where: 'projectId' in input
    ? { trigger: { scopeProjectId: input.projectId } }
    : 'boardId' in input
      ? { trigger: { scopeBoardId: input.boardId } }
      : { pinnedTerms: { path: ['pickupColumnIds'], array_contains: [input.columnId] } },
})
