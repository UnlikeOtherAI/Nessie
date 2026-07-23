import { Prisma, type PrismaClient } from '@prisma/client'
import { isJsonRecord } from '@nessie/runtime'

// Empty-fire skip: a scheduled/interval trigger that fires on a timer but whose
// work source is provably empty should record the fire as `skipped` instead of
// enqueueing a run, so it never burns tokens on a no-op. The decision is
// deliberately conservative — see `hasPendingThreadWork` — and only ever applies
// to triggers that explicitly opt in, so a schedule whose real work source is
// not the target thread is never skipped on a guess.

const SKIP_WHEN_EMPTY_KEY = 'skipWhenEmpty'

/**
 * A trigger only participates in empty-fire skipping when its config carries
 * `skipWhenEmpty === true`. Any other value (absent, `false`, or a
 * truthy-but-not-`true` value) keeps the default "always run" behaviour.
 */
export const triggerOptsIntoEmptySkip = (config: unknown): boolean =>
  isJsonRecord(config) && config[SKIP_WHEN_EMPTY_KEY] === true

/**
 * Reference point for "since the last fire": the last time this trigger actually
 * produced a run (`lastFiredAt`), falling back to when the trigger was created so
 * the very first fire measures activity since creation. Skips never advance
 * `lastFiredAt`, so the pending-work window keeps growing across consecutive
 * skips until real work finally appears.
 */
export const emptySkipReferenceTime = (input: {
  createdAt: Date
  lastFiredAt: Date | null
}): Date => input.lastFiredAt ?? input.createdAt

/**
 * The provable emptiness criterion. Returns true when at least one message has
 * been posted to the target thread since `since` by anyone other than this
 * trigger's own agent:
 *
 *  - human posts (`userId` set) count as pending work;
 *  - other agents' posts (`agentId` set and not this agent) count as pending
 *    work;
 *  - this trigger's own system-injected kickoffs (`userId` and `agentId` both
 *    null) and its agent's own replies (`agentId` = this agent) are excluded.
 *
 * A `false` result therefore means the thread has been genuinely quiet — the one
 * thing we can prove from the data model — so the fire is safe to skip. Anything
 * we cannot prove empty (a foreign message, a non-thread work source) returns
 * true and the trigger runs as normal.
 */
export const hasPendingThreadWork = async (
  prisma: Pick<PrismaClient, 'message'>,
  input: { agentId: string; since: Date; threadId: string },
): Promise<boolean> => {
  const count = await prisma.message.count({
    where: {
      threadId: input.threadId,
      deletedAt: null,
      createdAt: { gt: input.since },
      OR: [
        { userId: { not: null } },
        { AND: [{ agentId: { not: null } }, { agentId: { not: input.agentId } }] },
      ],
    },
  })
  return count > 0
}

/**
 * Persist a `skipped` delivery for an empty fire so it shows up in trigger
 * history exactly like a real delivery — making "this fire was skipped because
 * there was nothing to do" observable rather than silent. Idempotent on
 * `(triggerId, dedupeKey)`: if a concurrent real delivery already claimed the
 * same fire the unique-constraint violation is swallowed and the skip is
 * dropped.
 */
export const recordEmptyFireSkip = async (
  prisma: Pick<PrismaClient, 'agentTriggerDelivery'>,
  input: {
    dedupeKey: string
    payload: Prisma.InputJsonValue
    source: string
    triggerId: string
  },
): Promise<void> => {
  try {
    await prisma.agentTriggerDelivery.create({
      data: {
        triggerId: input.triggerId,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        source: input.source,
        status: 'skipped',
      },
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    throw error
  }
}
