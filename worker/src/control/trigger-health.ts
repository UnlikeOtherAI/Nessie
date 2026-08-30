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

  // One conditional statement, not a read followed by a write.
  //
  // Not every caller holds an exclusive claim on the trigger. The scheduler
  // sweep and the retry poller both do, but `dispatchEventTriggers` fans out to
  // every matching trigger with no claim at all, so two events arriving together
  // can fail the same trigger concurrently. A read-then-write would then let
  // both read the same revision and write the same successor — one transition
  // lost, or worse, two alerts for one failure.
  //
  // The WHERE clause carries the decision instead: the revision advances only
  // when this failure differs from the one already recorded, and whoever loses
  // the race matches nothing and returns no row. `IS DISTINCT FROM` rather than
  // `<>` because `health_reason` is nullable and `NULL <> 'x'` is NULL, which
  // would make a first-ever failure fail to match its own guard.
  // The transition and its alert commit together, or neither does.
  //
  // Writing the health first and enqueuing afterwards left a window that
  // recreated the very failure this exists to kill: once the UPDATE commits the
  // schedule is non-runnable and will never be swept again, and the guard's
  // "unchanged" branch means the next identical failure produces no transition —
  // so a crash between the two statements loses the only alert, permanently. One
  // transaction closes it: if the enqueue cannot be written, the health
  // transition rolls back too and the next sweep tries the whole thing again.
  let transition: TriggerHealthTransition | null = null
  try {
    transition = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ healthRevision: number }>>(
        Prisma.sql`
          UPDATE "agent_triggers"
          SET
            "health_detail" = ${input.error.message},
            "health_reason" = ${input.error.reason},
            "health_revision" = "health_revision" + 1,
            "status" = ${status}::"AgentTriggerStatus"
          WHERE "id" = ${input.triggerId}::uuid
            AND (
              "status" <> ${status}::"AgentTriggerStatus"
              OR "health_reason" IS DISTINCT FROM ${input.error.reason}
            )
          RETURNING "health_revision" AS "healthRevision"
        `,
      )

      const healthRevision = rows[0]?.healthRevision
      if (healthRevision === undefined) {
        return null
      }

      await enqueueQueueJob(tx, {
        // One job per transition. The consumer additionally writes a
        // `UserAlert` keyed on the same revision, so even a redelivered job
        // cannot double-notify: `user_alerts` is unique on (user_id, event_key).
        idempotencyKey: `trigger-health:${input.triggerId}:${healthRevision}`,
        payload: {
          healthRevision,
          reason: input.error.reason,
          status,
          triggerId: input.triggerId,
        } satisfies Prisma.InputJsonObject,
        topic: 'trigger.health-alert',
      })

      return { healthRevision, reason: input.error.reason, status, triggerId: input.triggerId }
    })
  } catch (persistError) {
    // The trigger may have been deleted between the fire and this write, or the
    // enqueue failed. Either way nothing was committed, so the next fire retries.
    console.error(
      '[worker.trigger-health] failed to record health transition for',
      input.triggerId,
      persistError,
    )
    return null
  }

  return transition
}
