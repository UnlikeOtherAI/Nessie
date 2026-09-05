/**
 * The sign-in hook for automatic team access.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §8.
 *
 * Called from `ensureTeamPrincipal`, inside its transaction. It matches the
 * address the token just asserted against the organisation's active domains and
 * enqueues the grants. Two properties matter and are easy to lose:
 *
 *  - **The email never leaves this function.** It is matched in memory and only
 *    rule ids reach the queue payload, because `queue_jobs` rows are never
 *    deleted anywhere in this repo and a payload email would be a permanent
 *    duplicate of UOA identity data.
 *  - **The idempotency key can never burn permanently.** `queue_jobs` has a
 *    full unique index on `idempotency_key` and the insert is
 *    `ON CONFLICT DO NOTHING`, so a key derived from anything durable would
 *    mean one dead job disables the feature for that person forever. A
 *    one-minute bucket collapses a burst of concurrent sign-ins and lets the
 *    next sign-in retry. Correctness never rests on this key — the grant ledger
 *    is the idempotency mechanism.
 */

import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import { AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC } from '@nessie/schemas'
import {
  isAutomaticMembershipEnabledForOrganization,
  matchAutomaticMembershipRules,
} from '@nessie/team-admin'

const BUCKET_MS = 60_000

export const enqueueAutomaticMembershipProvisioning = async (
  transaction: Prisma.TransactionClient,
  input: {
    organizationId: string
    uoaSub: string
    email: string
    /**
     * UOA does not assert this today. When it does, an explicit `false` is a
     * refusal — the same rule the generic-OIDC branch already applies.
     */
    emailVerified?: boolean
    now?: Date
  },
): Promise<string[]> => {
  // A failure here must never fail a sign-in. Automatic placement is a
  // convenience layered on top of authentication, not part of it.
  try {
    if (!(await isAutomaticMembershipEnabledForOrganization(transaction, input.organizationId))) {
      return []
    }
    const ruleIds = await matchAutomaticMembershipRules(transaction, {
      email: input.email,
      organizationId: input.organizationId,
      ...(input.emailVerified === undefined ? {} : { emailVerified: input.emailVerified }),
    })
    if (ruleIds.length === 0) return []

    const bucket = Math.floor((input.now?.getTime() ?? Date.now()) / BUCKET_MS)
    await enqueueQueueJob(transaction, {
      idempotencyKey:
        `auto-membership:provision:${input.organizationId}:${input.uoaSub}:${bucket}`,
      payload: { organizationId: input.organizationId, ruleIds, uoaSub: input.uoaSub },
      topic: AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
    })
    return ruleIds
  } catch (error) {
    console.error('automatic membership: sign-in enqueue failed', error)
    return []
  }
}
