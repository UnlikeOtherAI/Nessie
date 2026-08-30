import { Prisma, type PrismaClient } from '@prisma/client'

import { enqueueQueueJob } from '../queue.js'
import { TriggerLaunchOriginError } from './trigger-origin.js'

// A trigger that cannot run has to say so to a person, once.
//
// Before this, a fatal fire flipped `status` to `error` and stopped. The
// scheduler claims only `status = 'active'`, the delivery-retry poller clears
// `next_retry_at` for a non-active trigger, and nothing notified anyone — so the
// schedule was permanently dead and the sole record of why was the newest
// delivery row's `error_message`. A production sweep sat like that for 19 days.
//
// The transition now carries three things: the health STATE (which decides
// whether "Reauthorize" is offered), the REASON and detail (so the surface can
// explain without parsing a message), and a REVISION identifying this specific
// failure, which is what makes the alert exactly-once.

/** Non-runnable states this module can move a trigger into. */
type TriggerHealthStatus = 'error' | 'needs_reauthorization'

export type TriggerHealthTransition = {
  healthRevision: number
  reason: string
  status: TriggerHealthStatus
  triggerId: string
}

/**
 * Persist a classified failure and enqueue its alert.
 *
 * The status write is conditional on the trigger not already sitting in this
 * exact state: a schedule that keeps failing the same way must not bump its
 * revision on every sweep, or "once per transition" would become "once per
 * fire" and reproduce the notification spam this whole design avoids. The
 * revision therefore advances only when the health actually changes.
 *
 * Alerting is best-effort and never rethrows. The caller is already in a catch
 * block handling the real failure; losing the notification must not also lose
 * the delivery bookkeeping that records it.
 */
export const recordTriggerHealthFailure = async (
  prisma: PrismaClient,
  input: {
    error: TriggerLaunchOriginError
    triggerId: string
  },
): Promise<TriggerHealthTransition | null> => {
  const status: TriggerHealthStatus = input.error.isReauthorizable
    ? 'needs_reauthorization'
    : 'error'

  let transition: TriggerHealthTransition | null = null
  try {
    transition = await prisma.$transaction(async (tx) => {
      const current = await tx.agentTrigger.findUnique({
        where: { id: input.triggerId },
        select: { healthReason: true, healthRevision: true, status: true },
      })
      if (!current) {
        return null
      }

      const unchanged =
        current.status === status && current.healthReason === input.error.reason
      const healthRevision = unchanged
        ? current.healthRevision
        : current.healthRevision + 1

      await tx.agentTrigger.update({
        where: { id: input.triggerId },
        data: {
          healthDetail: input.error.message,
          healthReason: input.error.reason,
          healthRevision,
          status,
        },
      })

      return unchanged
        ? null
        : { healthRevision, reason: input.error.reason, status, triggerId: input.triggerId }
    })
  } catch (persistError) {
    // The trigger may have been deleted between the fire and this write.
    console.error(
      '[worker.trigger-health] failed to persist health for',
      input.triggerId,
      persistError,
    )
    return null
  }

  if (!transition) {
    return null
  }

  try {
    await enqueueQueueJob(prisma, {
      // One job per transition. The consumer additionally writes a `UserAlert`
      // keyed on the same revision, so even a duplicated job cannot double-
      // notify: `user_alerts` is unique on (user_id, event_key).
      idempotencyKey: `trigger-health:${transition.triggerId}:${transition.healthRevision}`,
      payload: {
        healthRevision: transition.healthRevision,
        reason: transition.reason,
        status: transition.status,
        triggerId: transition.triggerId,
      } satisfies Prisma.InputJsonObject,
      topic: 'trigger.health-alert',
    })
  } catch (enqueueError) {
    console.error(
      '[worker.trigger-health] failed to enqueue alert for',
      input.triggerId,
      enqueueError,
    )
  }

  return transition
}
