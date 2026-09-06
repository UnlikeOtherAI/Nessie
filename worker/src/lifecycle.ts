import { setTimeout as delay } from 'node:timers/promises'
import type { QueueSubscription } from '@nessie/runtime'

// Nacking on the deadline is the point: another worker re-claims the job now
// instead of waiting out the five-minute lock TTL of a process that has exited.
export const WORKER_DRAIN_TIMEOUT_REASON = 'worker_drain_timeout'

export const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 25_000

// Read straight from the environment rather than through `@nessie/config`'s
// `ConfigEnvMap`: the worker is the only consumer, and the config module is
// being edited by a sibling change in the same programme. A bad value would
// otherwise become a NaN deadline (`Promise.race` resolving immediately, so
// every drain aborts its handler), hence the finite/positive guard.
export const resolveDrainTimeoutMs = (
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const configured = Number(env['NESSIE_WORKER_DRAIN_TIMEOUT_MS'])
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_DRAIN_TIMEOUT_MS
}

// How often to dead-letter the rows `claimNextJob`'s timeout arm now refuses:
// `processing`, past their lock and already at `max_attempts`. Without the
// sweep those rows sit `processing` forever once the claim stops re-taking
// them.
export const DEAD_QUEUE_SWEEP_INTERVAL_MS = 60_000

// The sweep itself is a set-based UPDATE, so every replica may run it on its
// own interval: a second instance's pass is a no-op for the rows this one
// already moved. The in-flight flag is per process and correct that way — it
// only stops one process stacking overlapping passes on a slow database, and
// nothing outside this process needs to see it.
export const startDeadQueueJobSweep = (
  sweep: () => Promise<unknown>,
  options: { intervalMs?: number } = {},
): ReturnType<typeof setInterval> => {
  let inFlight = false

  return setInterval(() => {
    if (inFlight) {
      return
    }

    inFlight = true
    void sweep()
      .catch((error: unknown) => {
        console.error('[worker.queue-dead-sweep] failed', error)
      })
      .finally(() => {
        inFlight = false
      })
  }, options.intervalMs ?? DEAD_QUEUE_SWEEP_INTERVAL_MS)
}

export type DrainResult = {
  // True when the deadline passed with handlers still running, so their jobs
  // were abandoned rather than acked.
  timedOut: boolean
}

// Graceful half first: every subscription stops claiming, and the jobs already
// in flight run to completion (and get acked) while the caller waits. Only when
// the deadline passes are the handlers aborted and their jobs released.
export const drainQueueSubscriptions = async (
  subscriptions: readonly QueueSubscription[],
  options: { timeoutMs?: number } = {},
): Promise<DrainResult> => {
  for (const subscription of subscriptions) {
    subscription.stop()
  }

  if (subscriptions.length === 0) {
    return { timedOut: false }
  }

  const timeoutMs = options.timeoutMs ?? resolveDrainTimeoutMs()
  const deadline = new AbortController()
  const drained = Promise.allSettled(subscriptions.map((subscription) => subscription.done))
  const timedOut = await Promise.race([
    drained.then(() => false),
    delay(timeoutMs, true, { signal: deadline.signal }).catch(() => false),
  ])
  // Release the deadline timer either way, so a drain that finished early does
  // not hold the event loop open for the rest of the window.
  deadline.abort()

  if (!timedOut) {
    return { timedOut: false }
  }

  await Promise.allSettled(
    subscriptions.map((subscription) => subscription.abandon(WORKER_DRAIN_TIMEOUT_REASON)),
  )

  return { timedOut: true }
}
