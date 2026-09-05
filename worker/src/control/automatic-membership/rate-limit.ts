/**
 * Upstream call pacing for automatic membership.
 *
 * A reconciliation batch is one roster read plus up to `page × rules` member
 * writes, issued back to back — with three rules that is a 150-request burst,
 * so an inter-batch pause alone paces nothing. This token bucket applies to
 * every upstream call including the per-subject pre-read, and a second bucket
 * caps the whole process so N organisations reconciling at once cannot add up
 * to a thundering herd against UOA.
 */

const ORG_CALLS_PER_SECOND = 5
const INSTANCE_CALLS_PER_SECOND = 20

type Bucket = { tokens: number; updatedAt: number }

const buckets = new Map<string, Bucket>()

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms) })

const take = (key: string, ratePerSecond: number, now: number): number => {
  const bucket = buckets.get(key) ?? { tokens: ratePerSecond, updatedAt: now }
  const elapsed = Math.max(0, now - bucket.updatedAt)
  const refilled = Math.min(ratePerSecond, bucket.tokens + (elapsed * ratePerSecond) / 1000)
  if (refilled >= 1) {
    buckets.set(key, { tokens: refilled - 1, updatedAt: now })
    return 0
  }
  // Milliseconds until one whole token exists.
  const waitMs = Math.ceil(((1 - refilled) / ratePerSecond) * 1000)
  buckets.set(key, { tokens: refilled, updatedAt: now })
  return waitMs
}

/**
 * Wait until one upstream call is allowed for this organisation. Process-local
 * by design: it paces this worker's own bursts, which is what protects UOA from
 * a reconciliation walking fifty thousand members. It is not a distributed
 * limiter and does not pretend to be one.
 */
export const awaitUpstreamSlot = async (organizationId: string): Promise<void> => {
  for (;;) {
    const now = Date.now()
    const orgWait = take(`org:${organizationId}`, ORG_CALLS_PER_SECOND, now)
    const instanceWait = take('instance', INSTANCE_CALLS_PER_SECOND, now)
    const wait = Math.max(orgWait, instanceWait)
    if (wait === 0) return
    await sleep(wait)
  }
}

/** Test seam: forget accumulated state between cases. */
export const resetUpstreamRateLimit = (): void => { buckets.clear() }
