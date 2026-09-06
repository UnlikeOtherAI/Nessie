/**
 * Upstream call pacing for automatic membership.
 *
 * A reconciliation batch is one roster read plus up to `page × rules` member
 * writes, issued back to back — with three rules that is a 150-request burst,
 * so an inter-batch pause alone paces nothing. This limiter applies to every
 * upstream call including the per-subject pre-read, and a second, wider cap
 * holds for the whole deployment so N organisations reconciling at once cannot
 * add up to a thundering herd against UOA.
 *
 * **Both caps live in Postgres** (audit 5.6, plan row 5.3). They used to be two
 * module-scope token buckets, which made the "whole instance" cap `20 × N`
 * calls per second across N workers and gave one organisation `5 × N` whenever
 * two workers reconciled it at the same time — the cap that mattered least was
 * the only one the code could actually enforce. Each cap is now one
 * `rate_limit_buckets` row per one-second window, taken with the conditional
 * `INSERT … ON CONFLICT DO UPDATE … WHERE count < max` in `@nessie/db`
 * (`takeRateLimitSlot`), which is the same table and the same statement family
 * the API's brute-force limiter uses. There is no process-local bucket left:
 * the per-second window already bounds a single worker's burst to five calls
 * for one organisation, which is not the 150-call burst the local bucket was
 * written for, and a local fast path is exactly the thing that could admit a
 * call the deployment-wide cap would refuse.
 *
 * What the fixed window guarantees: `max` calls per window, and at worst
 * `2 × max` across a sliding window (the allowance of one window spent at its
 * end plus the next one's spent at its start). That bound does not grow with
 * the replica count, which is the whole point.
 */

import {
  clearRateLimitWindows,
  pruneRateLimitWindows,
  rateLimitKeyHash,
  takeRateLimitSlot,
  type FixedWindowRule,
  type RateLimitWindowStore,
} from '@nessie/db'

/** Per organisation, so one big roster cannot starve every other tenant. */
const ORG_BUCKET = 'uoa.automatic_membership.org'
const ORG_RULE: FixedWindowRule = { max: 5, windowMs: 1_000 }

/**
 * The whole deployment, every replica and every organisation together. The
 * identity is a constant because there is exactly one of these counters.
 */
const DEPLOYMENT_BUCKET = 'uoa.automatic_membership.deployment'
const DEPLOYMENT_IDENTITY = 'all'
const DEPLOYMENT_RULE: FixedWindowRule = { max: 20, windowMs: 1_000 }

/**
 * How long one call may wait for a slot before it goes ahead anyway.
 *
 * It has to be bounded: a waiter that loops forever against a saturated
 * deployment-wide bucket parks a reconciliation page indefinitely, and the
 * queue renews a job's lock for as long as the handler runs, so nothing else
 * would ever notice. Thirty seconds is comfortably inside the queue's 300 s
 * lock TTL (`packages/runtime/src/queue.ts`) even for a handler that hits the
 * ceiling several times, and long enough that ordinary contention — the org
 * cap is five per second — is absorbed by waiting rather than by overshoot.
 *
 * What happens at the ceiling: the call is **admitted**, with a loud log. This
 * limiter paces our own outbound traffic; it is not an authorization decision,
 * and none of its callers has a "refused" branch that means anything better
 * than failing the person's grant. Refusing would turn sustained contention
 * into failed reconciliations and released grant leases; admitting costs at
 * most one extra call per waiter per thirty seconds, which against a 20/s cap
 * is noise. The overshoot is bounded and observable; a stalled reconciliation
 * would be neither.
 */
const MAX_WAIT_MS = 30_000

/** Fraction of admitted calls that sweep expired rows out of the two buckets. */
const CLEANUP_PROBABILITY = 0.02

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Wait a whole window plus a little jitter. The jitter matters because every
 * waiter in the deployment is sleeping to the same window boundary, and they
 * would otherwise all wake into the same millisecond and race for the same
 * slots.
 */
const backoffFor = (resetInMs: number): number =>
  resetInMs + Math.floor(Math.random() * 100)

const pruneExpired = async (store: RateLimitWindowStore): Promise<void> => {
  const before = new Date(Date.now() - ORG_RULE.windowMs)
  await pruneRateLimitWindows(store, { before, bucket: ORG_BUCKET })
  await pruneRateLimitWindows(store, { before, bucket: DEPLOYMENT_BUCKET })
}

export type UpstreamSlot = {
  /** True when a slot was taken and the caller may make its upstream request. */
  admitted: boolean
  /** How long to wait before asking again. Zero when admitted. */
  retryInMs: number
  /**
   * The one-second window each cap was charged in, so an admission can be
   * attributed to the window that paid for it. The two are charged by separate
   * statements and so can land either side of a boundary; that is why this is a
   * pair rather than one number. `null` when no slot was taken, and also on the
   * fail-open path below — a caller that cares whether the store answered at
   * all can tell the difference.
   */
  windows: { deployment: number; org: number } | null
}

/**
 * Take one upstream slot if both caps have one, without waiting.
 *
 * The organisation cap is asked first and short-circuits: it is the tighter of
 * the two and therefore the likelier refusal, so asking it first keeps a
 * refused call from spending a deployment slot it will not use. The reverse
 * leak still exists — an organisation slot taken for a call the deployment cap
 * then refuses is spent — but it only ever makes this worker more
 * conservative, and the window resets a second later.
 *
 * Fails **open** on a store error, loudly. A limiter outage must not stop
 * membership work; the same trade the API's limiter makes on the same table.
 */
export const tryUpstreamSlot = async (
  store: RateLimitWindowStore,
  organizationId: string,
): Promise<UpstreamSlot> => {
  try {
    const org = await takeRateLimitSlot(store, {
      bucket: ORG_BUCKET,
      keyHash: rateLimitKeyHash(ORG_BUCKET, organizationId),
      rule: ORG_RULE,
    })
    if (!org.admitted) {
      return { admitted: false, retryInMs: backoffFor(org.resetInMs), windows: null }
    }
    const deployment = await takeRateLimitSlot(store, {
      bucket: DEPLOYMENT_BUCKET,
      keyHash: rateLimitKeyHash(DEPLOYMENT_BUCKET, DEPLOYMENT_IDENTITY),
      rule: DEPLOYMENT_RULE,
    })
    if (!deployment.admitted) {
      return {
        admitted: false,
        retryInMs: backoffFor(deployment.resetInMs),
        windows: null,
      }
    }
    if (Math.random() < CLEANUP_PROBABILITY) await pruneExpired(store)
    return {
      admitted: true,
      retryInMs: 0,
      windows: { deployment: deployment.windowStartMs, org: org.windowStartMs },
    }
  } catch (error) {
    console.error(
      '[automatic-membership] FAIL-OPEN: upstream pacing store unavailable, '
      + `allowing the call: ${String(error)}`,
    )
    return { admitted: true, retryInMs: 0, windows: null }
  }
}

/**
 * Wait until one upstream call is allowed for this organisation.
 *
 * Blocks rather than throwing, because callers use it to pace a walk over a
 * roster that can run to tens of thousands of members and have nowhere to put
 * a refusal. Nothing is held while it sleeps: each attempt is one statement on
 * a connection Prisma hands straight back, and there is no transaction — a
 * waiter parked on a pooled connection is how N workers exhaust a pool.
 *
 * Bounded by `MAX_WAIT_MS`; see that constant for what the ceiling does and
 * why it does that.
 */
export const awaitUpstreamSlot = async (
  store: RateLimitWindowStore,
  organizationId: string,
): Promise<void> => {
  const deadline = Date.now() + MAX_WAIT_MS
  for (;;) {
    const slot = await tryUpstreamSlot(store, organizationId)
    if (slot.admitted) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      console.warn(
        `[automatic-membership] upstream pacing: waited ${MAX_WAIT_MS}ms for a slot for `
        + `organisation ${organizationId} and proceeded anyway; the deployment is at its `
        + 'UnlikeOtherAI call ceiling.',
      )
      return
    }
    await sleep(Math.min(slot.retryInMs, remaining))
  }
}

/**
 * Test seam: forget every accumulated window, live ones included.
 *
 * Both buckets are deployment-wide, so this discards allowance a running
 * deployment is relying on — it belongs to a suite that owns its database.
 */
export const resetUpstreamRateLimit = async (
  store: RateLimitWindowStore,
): Promise<void> => {
  await clearRateLimitWindows(store, ORG_BUCKET)
  await clearRateLimitWindows(store, DEPLOYMENT_BUCKET)
}

/** The caps this module enforces, published so nothing has to restate them. */
export const UPSTREAM_RATE_LIMITS = {
  deployment: DEPLOYMENT_RULE,
  org: ORG_RULE,
} as const
