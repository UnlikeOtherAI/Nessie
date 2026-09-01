import type { PrismaClient } from '@prisma/client'
import {
  resolveDisclosureViewer as resolveRuntimeDisclosureViewer,
  type DisclosureViewer,
} from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

/**
 * Who a run reads as, for the disclosure predicate.
 *
 * A run's *reach* (what it may recall) and its *viewer* (what it may re-read
 * from the transcript) are the same question asked of the same person, so this
 * resolves from the same `effectiveUserId` the memory path already uses.
 *
 * Scheduled and trigger-fired runs are not anonymous: they carry the immutable
 * `createdByUserId` of whoever set them up, and that identity is revalidated
 * against live org/team membership when the trigger fires, arriving here as
 * `effectiveUserId`. So a schedule reads as its owner. Only genuine
 * automation with no originating user — a system job with no owner — resolves
 * to `autonomous`, which sees unrestricted content only.
 *
 * Entitlements are always resolved live from the user id. The stored
 * project/team tuple on a trigger is last-seen metadata, not authority.
 */
export const resolveDisclosureViewer = async (
  prisma: PrismaClient,
  payload: RunExecuteJobPayload,
  organizationId: string,
): Promise<DisclosureViewer> => {
  const effectiveUserId =
    payload.actorContext.actionContext.effectiveUserId
    ?? (payload.actorContext.actor.actorType === 'user'
      ? payload.actorContext.actor.actorId
      : undefined)

  return resolveRuntimeDisclosureViewer(prisma, organizationId, effectiveUserId)
}
