import type { Prisma } from '@prisma/client'
import {
  standingPolicyLimitsOf,
  standingPolicyTermsDigest,
  standingPolicyTermsOf,
  suspendStandingPolicyInTransaction,
  writeStandingPolicyAudit,
  type StandingPolicyActor,
} from '@nessie/executor-manage'
import { StandingPolicyPinnedTermsSchema } from '@nessie/schemas'

import { judgeStandingPolicyTermsChange } from './standing-policy-terms.js'

/**
 * What a saved edit of a ticket trigger does to the machine access it holds,
 * inside the edit's own transaction (docs/standards/ticket-work.md → "Limits
 * and digests"). Whoever saves it, the author included:
 *
 * - nothing pinned changed: nothing happens;
 * - only a limit went down: the policy stays live and its terms and digest
 *   move down with it, so the binder's digest check still matches;
 * - anything else changed: the policy is suspended (`trigger_changed`) and
 *   binds nothing until its author confirms a fresh card, which shows what
 *   changed.
 *
 * A suspended policy stays suspended whatever a later edit does; a card still
 * waiting for confirmation is refused at confirm, because its terms no longer
 * match the trigger.
 */
export type StandingPolicyTriggerEditEffect =
  | { kind: 'limits_lowered' }
  | { authorName: string; fields: string[]; kind: 'suspended' }

export const applyTriggerEditToStandingPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: StandingPolicyActor
    trigger: { agentId: string | null; config: unknown; id: string; targetChannelId: string | null }
  },
): Promise<StandingPolicyTriggerEditEffect | null> => {
  const policy = await tx.executorStandingPolicy.findFirst({
    where: { status: 'live', triggerId: input.trigger.id },
    select: { author: { select: { displayName: true } }, id: true, organizationId: true, pinnedTerms: true },
  })
  if (!policy) return null
  const pinned = StandingPolicyPinnedTermsSchema.safeParse(policy.pinnedTerms)
  const current = pinned.success ? standingPolicyTermsOf(input.trigger, standingPolicyLimitsOf(pinned.data)) : null
  const judged = pinned.success && current
    ? judgeStandingPolicyTermsChange(pinned.data, current)
    : { fields: ['the trigger\'s configuration'], kind: 'changed' as const }
  if (judged.kind === 'same') return null
  if (judged.kind === 'lowered' && current) {
    const triggerDigest = standingPolicyTermsDigest(current)
    await tx.executorStandingPolicy.update({
      where: { id: policy.id },
      data: { pinnedTerms: current as unknown as Prisma.InputJsonValue, triggerDigest },
    })
    await writeStandingPolicyAudit(tx, {
      action: 'executor.policy.limits_lowered',
      actor: input.actor,
      metadata: { limits: current.limits, triggerDigest, triggerId: input.trigger.id },
      organizationId: policy.organizationId,
      policyId: policy.id,
    })
    return { kind: 'limits_lowered' }
  }
  const fields = judged.kind === 'changed' ? judged.fields : []
  await suspendStandingPolicyInTransaction(tx, {
    actor: input.actor,
    detail: { changed: fields },
    policyId: policy.id,
    reason: 'trigger_changed',
  })
  return { authorName: policy.author.displayName, fields, kind: 'suspended' }
}

/** What an edit that suspended machine access tells whoever saved it. */
export const standingPolicyTriggerEditSentence = (effect: StandingPolicyTriggerEditEffect): string =>
  effect.kind === 'limits_lowered'
    ? 'Machine access stays on: lowering a limit needs no new confirmation.'
    : `Saving paused ${effect.authorName}'s machine access for this trigger until they confirm it again `
      + `(changed: ${effect.fields.join(', ')}). Tickets being worked wait for it.`
