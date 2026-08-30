import { Prisma, type PrismaClient } from '@prisma/client'
import type { AgentTriggerType } from '@nessie/schemas'
import { MAX_DELIVERY_RETRIES, computeNextRetryAt } from '@nessie/runtime'

// sp-webhook: trigger-delivery retry/backoff.
//
// A delivery whose dispatch transaction fails (e.g. a transient DB error while
// creating the run) is left in `failed` status with `retryCount` incremented and
// `nextRetryAt` set to an exponential-backoff instant. The worker poller
// (`retryFailedTriggerDeliveries`) re-attempts due deliveries, reusing the same
// delivery row so the `(trigger_id, dedupe_key)` uniqueness is preserved.
// The backoff policy itself lives in @nessie/runtime/scheduling so the API
// dispatch path and this worker poller share one source of truth.

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Record (or update) a retryable `failed` delivery after a dispatch failure.
// Runs OUTSIDE the failed transaction so the bookkeeping survives the rollback.
// When `existingDeliveryId` is provided (a retry attempt) the row is updated in
// place; otherwise a new `failed` row is created so the poller can pick it up.
export const recordDeliveryFailure = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string | null
    error: unknown
    existingDeliveryId?: string
    payload: Prisma.InputJsonValue
    retryCount: number
    source: string
    triggerId: string
  },
): Promise<void> => {
  const nextRetryCount = input.retryCount + 1
  // `>=`, not `>`: the poller selects `retryCount < MAX_DELIVERY_RETRIES`, so a
  // row that lands on exactly MAX kept a due `nextRetryAt` it would never be
  // picked up for — a delivery that reads as "retry pending" forever while
  // nothing retries it. Exhaustion is now the same boundary on both sides.
  const exhausted = nextRetryCount >= MAX_DELIVERY_RETRIES
  const nextRetryAt = exhausted ? null : computeNextRetryAt(input.retryCount)
  const errorMessage = errorMessageOf(input.error)

  if (input.existingDeliveryId) {
    await prisma.agentTriggerDelivery.update({
      where: { id: input.existingDeliveryId },
      data: {
        status: 'failed',
        errorMessage,
        retryCount: nextRetryCount,
        nextRetryAt,
      },
    })
    return
  }

  // First failure for this (trigger, dedupeKey). Use an upsert-by-unique when a
  // dedupeKey is present so a concurrent attempt doesn't violate the constraint;
  // otherwise create a standalone failed row.
  if (input.dedupeKey) {
    await prisma.agentTriggerDelivery.upsert({
      where: {
        triggerId_dedupeKey: {
          triggerId: input.triggerId,
          dedupeKey: input.dedupeKey,
        },
      },
      create: {
        triggerId: input.triggerId,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        source: input.source,
        status: 'failed',
        errorMessage,
        retryCount: nextRetryCount,
        nextRetryAt,
      },
      update: {
        status: 'failed',
        errorMessage,
        retryCount: nextRetryCount,
        nextRetryAt,
      },
    })
    return
  }

  await prisma.agentTriggerDelivery.create({
    data: {
      triggerId: input.triggerId,
      payload: input.payload,
      source: input.source,
      status: 'failed',
      errorMessage,
      retryCount: nextRetryCount,
      nextRetryAt,
    },
  })
}

type RetryReattempt = (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    reuseDeliveryId: string
    retryCount: number
    source: string
    triggerId: string
    type: AgentTriggerType
  },
) => Promise<void>

// Poller: pick up `failed` deliveries that are due (nextRetryAt <= now) and
// re-attempt them via the supplied dispatcher. The dispatcher reuses the
// delivery row and, on a fresh failure, increments backoff again.
export const retryFailedTriggerDeliveries = async (
  prisma: PrismaClient,
  reattempt: RetryReattempt,
  options: { limit?: number } = {},
): Promise<void> => {
  const limit = options.limit ?? 10
  const now = new Date()

  // Claim, don't just read. A plain `findMany` let every worker replica select
  // the same due rows and re-attempt them concurrently: the per-(agent, thread)
  // lock serialises the resulting runs but not the distinct kickoff messages
  // they each pend, and the workflow path can create genuinely separate runs.
  // `FOR UPDATE SKIP LOCKED` inside a claiming UPDATE is the same shape the
  // scheduler's own `claimDueScheduledTriggers` uses — one row goes to exactly
  // one worker. Clearing `next_retry_at` as we claim is what makes it a claim:
  // a crashed attempt leaves the row `failed` with backoff state intact, and the
  // re-attempt path re-arms it on its next failure.
  const due = await prisma.$queryRaw<Array<{
    dedupeKey: string | null
    id: string
    payload: unknown
    retryCount: number
    source: string | null
    triggerId: string
    type: AgentTriggerType
  }>>(
    Prisma.sql`
      WITH due AS (
        SELECT d.id
        FROM "agent_trigger_deliveries" AS d
        WHERE d."status" = 'failed'::"AgentTriggerDeliveryStatus"
          AND d."next_retry_at" IS NOT NULL
          AND d."next_retry_at" <= ${now}
          AND d."retry_count" < ${MAX_DELIVERY_RETRIES}
        ORDER BY d."next_retry_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "agent_trigger_deliveries" AS d
      SET "next_retry_at" = NULL
      FROM due, "agent_triggers" AS t
      WHERE d."id" = due."id" AND t."id" = d."trigger_id"
      RETURNING
        d."dedupe_key" AS "dedupeKey",
        d."id",
        d."payload",
        d."retry_count" AS "retryCount",
        d."source",
        d."trigger_id" AS "triggerId",
        t."type"
    `,
  )

  for (const delivery of due) {
    try {
      await reattempt(prisma, {
        dedupeKey: delivery.dedupeKey ?? undefined,
        payload: delivery.payload,
        reuseDeliveryId: delivery.id,
        retryCount: delivery.retryCount,
        source: delivery.source ?? 'webhook',
        triggerId: delivery.triggerId,
        type: delivery.type,
      })
    } catch (error) {
      // The reattempt path records its own failure/backoff; only the unexpected
      // (non-dispatch) errors surface here.
      console.error('[worker.trigger-retry] reattempt failed', delivery.id, error)
    }
  }
}
