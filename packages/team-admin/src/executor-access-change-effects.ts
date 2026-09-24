import type { Prisma } from '@prisma/client'
import { suspendStandingPolicyInTransaction, type ExecutorAccessChange } from '@nessie/executor-manage'
import { ExecutorCapabilityDescriptorSchema, type AuthorizedActionContext } from '@nessie/schemas'

import { applyExecutorAgentPolicyChange } from './executor-agent-tool-policy.js'
import { confirmStandingPolicyInTransaction, rejectStandingPolicyInTransaction } from './standing-policy-confirm.js'

/**
 * What a confirmed executor access change does beyond the executor rows
 * `@nessie/executor-manage` writes: the route's `applyPolicy`, inside the
 * continuation's own transaction, so an invalid token, stale authority or a
 * failed mutation writes none of it.
 *
 * - An agent grant enables or withdraws the executor tools in the agent's
 *   tool policy.
 * - A standing policy's card is confirmed whole
 *   (`confirmStandingPolicyInTransaction`).
 * - A descriptor review that leaves a pool machine with other digests than a
 *   live standing policy pinned — a changed coding-sessions configuration or
 *   local policy, or no live revision at all — suspends that policy
 *   (`descriptor_changed`) until its author confirms a fresh card.
 */

const suspendForDescriptorReview = async (
  tx: Prisma.TransactionClient,
  input: {
    actorContext: AuthorizedActionContext
    executorId: string
    revision: number
    status: 'active' | 'disabled'
  },
): Promise<void> => {
  const pooled = await tx.executorStandingPolicyExecutor.findMany({
    where: { executorId: input.executorId, policy: { status: 'live' } },
    select: { descriptorConfigDigest: true, localPolicyDigest: true, policyId: true },
  })
  if (pooled.length === 0) return
  // `applyPolicy` runs before the review is written, so this reads the
  // revision it is reviewing — which is what stays live once it commits.
  const reviewed = input.status === 'active'
    ? await tx.executorCapabilityRevision.findFirst({
        where: { executorId: input.executorId, revision: input.revision },
        select: { descriptor: true, localPolicyDigest: true },
      })
    : null
  const descriptor = reviewed ? ExecutorCapabilityDescriptorSchema.safeParse(reviewed.descriptor) : null
  const facts = descriptor?.success ? descriptor.data.codingSessions : undefined
  for (const pool of pooled) {
    if (reviewed && facts && facts.configDigest === pool.descriptorConfigDigest
      && reviewed.localPolicyDigest === pool.localPolicyDigest) continue
    await suspendStandingPolicyInTransaction(tx, {
      actor: { requestId: input.actorContext.actionContext.requestId, userId: input.actorContext.actor.actorId },
      detail: { executorId: input.executorId, revision: input.revision, reviewStatus: input.status },
      policyId: pool.policyId,
      reason: 'descriptor_changed',
    })
  }
}

export const applyExecutorAccessChangeEffects = async (
  tx: Prisma.TransactionClient,
  input: {
    actorContext: AuthorizedActionContext
    change: ExecutorAccessChange
    executorId: string
    ledgerSigningConfigured: boolean
  },
): Promise<void> => {
  const { actorContext, change, executorId } = input
  if (change.kind === 'standing_policy') {
    await confirmStandingPolicyInTransaction(tx, {
      actorContext, change, ledgerSigningConfigured: input.ledgerSigningConfigured,
    })
    return
  }
  if (change.kind === 'descriptor_review') {
    await suspendForDescriptorReview(tx, { actorContext, executorId, revision: change.revision, status: change.status })
    return
  }
  await applyExecutorAgentPolicyChange(tx, {
    actorUserId: actorContext.actor.actorId, change, executorId, organizationId: actorContext.tenant.organizationId,
  })
}

/** What a rejected change undoes beyond its continuation: a standing policy's card ends with it. */
export const applyRejectedExecutorAccessChangeEffects = async (
  tx: Prisma.TransactionClient,
  input: { actorContext: AuthorizedActionContext; change: ExecutorAccessChange },
): Promise<void> => {
  if (input.change.kind === 'standing_policy') {
    await rejectStandingPolicyInTransaction(tx, { actorContext: input.actorContext, change: input.change })
  }
}
