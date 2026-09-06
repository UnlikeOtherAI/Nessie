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
 * **Every cap lives in Postgres** (audit 5.6, plan row 5.3). They used to be two
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
 * call the deployment-wide cap would refuse. The window itself is floored from
 * the database's `NOW()`, not from any worker's clock, so a skewed host cannot
 * end up counting against a row of its own.
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
 * The allowance a waiter that has run out of patience draws on, deployment-wide
 * like the cap above and for the same reason. See `awaitUpstreamSlot`: a
 * ceiling that simply admits is a cap of `waiters / ceiling` per second, which
 * is no cap at all. Two per second against a 20/s deployment cap is a tenth
 * more traffic in the worst case, and it is a *ceiling* rather than an
 * estimate.
 */
const OVERSHOOT_BUCKET = 'uoa.automatic_membership.overshoot'
const OVERSHOOT_IDENTITY = 'all'
const OVERSHOOT_RULE: FixedWindowRule = { max: 2, windowMs: 1_000 }

/**
 * How long one call paces politely before it starts drawing on the overshoot
 * allowance, and how long before it stops pacing altogether.
 *
 * Both have to be bounded: a waiter that loops forever against a saturated
 * deployment-wide bucket parks a reconciliation page indefinitely, and the
 * queue renews a job's lock for as long as the handler runs, so nothing else
 * would ever notice. Both are also **drawn per call**, not shared. A fixed
 * thirty-second ceiling is a deadline every co-launched waiter agrees on: a
 * sweep that starts a hundred reconciliation jobs together would park them
 * together and discharge them together, which is the thundering herd this
 * module exists to prevent arriving by a different door. The draw is uniform
 * over `[minCeilingMs, maxCeilingMs)`, and the hard stop is a multiple of that
 * same draw so it inherits the spread instead of re-synchronising at 4×30 s.
 *
 * With the defaults a waiter paces normally for 30–60 s, then competes for the
 * overshoot allowance, and only if it is still refused 120–240 s in does it
 * proceed uncounted — comfortably inside the queue's 300 s lock TTL
 * (`packages/runtime/src/queue.ts`).
 *
 * Do not read the hard stop as exceptional. The overshoot lane is a single
 * deployment-wide 2/s cap, so a broad multi-organisation sweep saturates it at
 * once and the waiters behind it reach their stops as a matter of course. It is
 * the ordinary end state of sustained saturation, not a rare one — which is why
 * every crossing logs at error level and why the bound below is stated as
 * conditional rather than absolute.
 *
 * What this guarantees, and what it does not: **while the store answers, the
 * deployment's upstream rate is at most `DEPLOYMENT_RULE.max +
 * OVERSHOOT_RULE.max` per window however many waiters there are** — the
 * overshoot lane is a counted cap, not a per-waiter allowance. Past the hard
 * stop a waiter proceeds without charging anything, so past it there is no
 * bound at all: the uncounted rate is roughly waiters over the mean stop, which
 * is linear in how many callers are parked. The admissions are at least spread
 * by the same per-call draw rather than arriving in a spike, and each logs at
 * error level. Note too that the counted bound is per fixed window, so a
 * sliding window can see twice it across a boundary. Admitting is still the right end of the trade: this limiter
 * paces our own outbound traffic, it is not an authorization decision, and no
 * caller has a "refused" branch better than failing a person's membership
 * grant.
 */
export type UpstreamPacing = {
  /** Inclusive lower bound of the per-call ceiling draw. */
  minCeilingMs: number
  /** Exclusive upper bound of the per-call ceiling draw. */
  maxCeilingMs: number
  /** The unconditional stop, as a multiple of this call's own drawn ceiling. */
  hardCeilingMultiple: number
}

export const DEFAULT_UPSTREAM_PACING: UpstreamPacing = {
  hardCeilingMultiple: 4,
  maxCeilingMs: 60_000,
  minCeilingMs: 30_000,
}

/**
 * Draw one call's ceiling. Exported so a suite can assert the spread directly
 * rather than inferring it from timings.
 */
export const drawUpstreamCeilingMs = (
  pacing: UpstreamPacing = DEFAULT_UPSTREAM_PACING,
): number => {
  const spread = Math.max(0, pacing.maxCeilingMs - pacing.minCeilingMs)
  return pacing.minCeilingMs + Math.floor(Math.random() * spread)
}

/** Fraction of admitted calls that sweep expired rows out of the buckets. */
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

/**
 * Housekeeping, and **never** a limiter outage.
 *
 * This runs on a fraction of admitted calls, after the store has already
 * answered. Letting its error reach the caller's fail-open handler made a
 * failed cleanup delete log `FAIL-OPEN: upstream pacing store unavailable,
 * allowing the call` when the store was fine and nothing extra had been
 * allowed — a cleanup fault impersonating the one signal that says the cap is
 * off. It gets its own line, and the call it was riding on is unaffected.
 *
 * The cutoffs are database-anchored (`olderThanMs` against `NOW()`), so a
 * worker with a fast clock cannot delete the live window a slower worker is
 * still counting against and hand it a second allowance.
 */
const pruneExpired = async (store: RateLimitWindowStore): Promise<void> => {
  try {
    await pruneRateLimitWindows(store, {
      bucket: ORG_BUCKET,
      olderThanMs: ORG_RULE.windowMs,
    })
    await pruneRateLimitWindows(store, {
      bucket: DEPLOYMENT_BUCKET,
      olderThanMs: DEPLOYMENT_RULE.windowMs,
    })
    await pruneRateLimitWindows(store, {
      bucket: OVERSHOOT_BUCKET,
      olderThanMs: OVERSHOOT_RULE.windowMs,
    })
  } catch (error) {
    console.warn(
      '[automatic-membership] upstream pacing: expired-window sweep failed; the '
      + `limiter itself answered and nothing extra was allowed: ${String(error)}`,
    )
  }
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
 * Only the limiter's own statements are inside that handler — see
 * `pruneExpired`.
 *
 * `cleanupProbability` is a test seam, the same one `RateLimiter` carries in
 * the API: 1 makes the housekeeping sweep deterministic.
 */
export const tryUpstreamSlot = async (
  store: RateLimitWindowStore,
  organizationId: string,
  cleanupProbability: number = CLEANUP_PROBABILITY,
): Promise<UpstreamSlot> => {
  let windows: { deployment: number; org: number }
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
    windows = { deployment: deployment.windowStartMs, org: org.windowStartMs }
  } catch (error) {
    console.error(
      '[automatic-membership] FAIL-OPEN: upstream pacing store unavailable, '
      + `allowing the call: ${String(error)}`,
    )
    return { admitted: true, retryInMs: 0, windows: null }
  }
  if (Math.random() < cleanupProbability) await pruneExpired(store)
  return { admitted: true, retryInMs: 0, windows }
}

type OvershootSlot = {
  admitted: boolean
  /** True when the store errored, so the admission was not counted anywhere. */
  storeError: boolean
  retryInMs: number
  windowStartMs: number | null
}

/**
 * Take one slot from the overshoot allowance. Only `awaitUpstreamSlot` past its
 * ceiling calls this; it is deliberately not exported, because "I have waited
 * long enough" is the only reason to spend it.
 */
const tryOvershootSlot = async (
  store: RateLimitWindowStore,
): Promise<OvershootSlot> => {
  try {
    const slot = await takeRateLimitSlot(store, {
      bucket: OVERSHOOT_BUCKET,
      keyHash: rateLimitKeyHash(OVERSHOOT_BUCKET, OVERSHOOT_IDENTITY),
      rule: OVERSHOOT_RULE,
    })
    return {
      admitted: slot.admitted,
      retryInMs: slot.admitted ? 0 : backoffFor(slot.resetInMs),
      storeError: false,
      windowStartMs: slot.admitted ? slot.windowStartMs : null,
    }
  } catch (error) {
    console.error(
      '[automatic-membership] FAIL-OPEN: upstream overshoot store unavailable, '
      + `allowing the call: ${String(error)}`,
    )
    return { admitted: true, retryInMs: 0, storeError: true, windowStartMs: null }
  }
}

/** How a call was let through, so an operator (and a suite) can tell them apart. */
export type UpstreamAdmissionMode =
  /** A normal paced slot: both caps had room. */
  | 'slot'
  /** The waiter passed its ceiling and drew on the counted overshoot allowance. */
  | 'overshoot'
  /** The waiter passed its hard stop. Nothing was charged; the cap is exceeded. */
  | 'hard-ceiling'
  /** The pacing store did not answer. Nothing was charged; the cap is off. */
  | 'store-error'

export type UpstreamAdmission = {
  mode: UpstreamAdmissionMode
  /**
   * The one-second window that paid for this call — the organisation window for
   * a `slot`, the overshoot window for an `overshoot`. `null` for the two
   * uncounted modes, where by definition nothing paid.
   */
  windowStartMs: number | null
  /** How long the caller waited before it was let through. */
  waitedMs: number
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
 * A real slot is preferred at every iteration, ceiling or no ceiling: passing
 * the ceiling adds the overshoot lane, it does not abandon the normal one.
 *
 * See `UpstreamPacing` for what the two deadlines are, why each call draws its
 * own, and exactly what the pair does and does not guarantee.
 */
export const awaitUpstreamSlot = async (
  store: RateLimitWindowStore,
  organizationId: string,
  pacing: UpstreamPacing = DEFAULT_UPSTREAM_PACING,
): Promise<UpstreamAdmission> => {
  const startedAt = Date.now()
  const ceilingMs = drawUpstreamCeilingMs(pacing)
  const ceilingAt = startedAt + ceilingMs
  const hardCeilingAt = startedAt + ceilingMs * pacing.hardCeilingMultiple
  let announcedCeiling = false
  for (;;) {
    const slot = await tryUpstreamSlot(store, organizationId)
    if (slot.admitted) {
      return {
        mode: slot.windows === null ? 'store-error' : 'slot',
        waitedMs: Date.now() - startedAt,
        windowStartMs: slot.windows?.org ?? null,
      }
    }

    const beforeCeiling = Date.now()
    if (beforeCeiling < ceilingAt) {
      await sleep(Math.min(slot.retryInMs, ceilingAt - beforeCeiling))
      continue
    }

    if (!announcedCeiling) {
      announcedCeiling = true
      console.warn(
        `[automatic-membership] upstream pacing: waited ${beforeCeiling - startedAt}ms `
        + `for a slot for organisation ${organizationId} and is now competing for the `
        + 'overshoot allowance; the deployment is at its UnlikeOtherAI call ceiling.',
      )
    }
    const overshoot = await tryOvershootSlot(store)
    if (overshoot.admitted) {
      return {
        mode: overshoot.storeError ? 'store-error' : 'overshoot',
        waitedMs: Date.now() - startedAt,
        windowStartMs: overshoot.windowStartMs,
      }
    }

    const afterOvershoot = Date.now()
    if (afterOvershoot >= hardCeilingAt) {
      console.error(
        `[automatic-membership] upstream pacing: waited ${afterOvershoot - startedAt}ms `
        + `for organisation ${organizationId}, could not take even an overshoot slot, `
        + 'and proceeded UNCOUNTED; the deployment-wide UnlikeOtherAI cap is exceeded '
        + 'for this call.',
      )
      return { mode: 'hard-ceiling', waitedMs: afterOvershoot - startedAt, windowStartMs: null }
    }
    await sleep(Math.min(overshoot.retryInMs, hardCeilingAt - afterOvershoot))
  }
}

/**
 * Test seam: forget every accumulated window, live ones included.
 *
 * All three buckets are deployment-wide, so this discards allowance a running
 * deployment is relying on — it belongs to a suite that owns its database.
 */
export const resetUpstreamRateLimit = async (
  store: RateLimitWindowStore,
): Promise<void> => {
  await clearRateLimitWindows(store, ORG_BUCKET)
  await clearRateLimitWindows(store, DEPLOYMENT_BUCKET)
  await clearRateLimitWindows(store, OVERSHOOT_BUCKET)
}

/** The caps this module enforces, published so nothing has to restate them. */
export const UPSTREAM_RATE_LIMITS = {
  deployment: DEPLOYMENT_RULE,
  org: ORG_RULE,
  overshoot: OVERSHOOT_RULE,
} as const
