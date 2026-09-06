import { setTimeout as delay } from 'node:timers/promises'
import type { QueueSubscription } from '@nessie/runtime'

// Nacking on the deadline is the point: another worker re-claims the job now
// instead of waiting out the five-minute lock TTL of a process that has exited.
export const WORKER_DRAIN_TIMEOUT_REASON = 'worker_drain_timeout'

export const DEFAULT_WORKER_DRAIN_TIMEOUT_MS = 25_000

// The second, shorter window: how long an ABANDONED handler is given to fall
// out of its final writes before the caller closes the pool and the Prisma
// client under it. Nacking released the row already, so this is not about the
// queue — it is about the writes the handler still has in flight (releasing the
// run's executor claim, its terminal status), which throw on a closed pool and
// leave a successor looking at a run "held by a live executor" that no longer
// exists.
//
// Bounded rather than open-ended: a handler parked in an await nothing can
// interrupt would otherwise hold SIGTERM open until the platform SIGKILLs the
// process, which loses strictly more than closing under one straggler does.
// 25 s + 5 s stays comfortably inside the sixty-second grace invariant 6 names.
export const DEFAULT_WORKER_ABANDON_SETTLE_MS = 5_000

// The third and last window: how long `stop()` will wait for the transports
// themselves to close once the drain is over. `pool.end()` resolves only when
// every checked-out client has been returned, so an abandoned handler whose
// final write is blocked on a row lock the successor now holds keeps its client
// out indefinitely — and an unbounded close hands back exactly what the settle
// window was bounded to prevent: the process outlives its termination grace and
// is SIGKILLed anyway, which loses more than closing under a straggler does.
//
// 25 s drain + 5 s settle + 10 s teardown is 40 s, comfortably inside the sixty
// seconds invariant 6 names.
export const DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS = 10_000

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
  // True when an abandoned handler was STILL running when the settle window
  // expired. The caller is about to close the pool underneath it, so whatever
  // that handler was writing is lost — the one outcome this drain cannot
  // prevent, and the reason it is reported rather than swallowed.
  settleTimedOut: boolean
  // True when the deadline passed with handlers still running, so their jobs
  // were abandoned rather than acked.
  timedOut: boolean
}

// Wait for `settled`, giving up after `timeoutMs`; true means the deadline won.
// The timer is released either way, so a wait that finished early does not hold
// the event loop open for the rest of its window.
const raceDeadline = async (settled: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  const deadline = new AbortController()
  const timedOut = await Promise.race([
    settled.then(() => false),
    delay(timeoutMs, true, { signal: deadline.signal }).catch(() => false),
  ])
  deadline.abort()
  return timedOut
}

// Graceful half first: every subscription stops claiming AND tells the job it
// already holds that the drain has begun, so a handler that knows how to wind
// down spends the whole grace window doing it rather than hearing about it at
// the end. A handler that ignores the signal runs to completion and is acked,
// exactly as before.
//
// Only when the deadline passes are the jobs released — and then the drain
// still waits, briefly, for those handlers to fall out, because the caller's
// next act is to close the pool and the Prisma client they are writing through.
export const drainQueueSubscriptions = async (
  subscriptions: readonly QueueSubscription[],
  options: { settleMs?: number; timeoutMs?: number } = {},
): Promise<DrainResult> => {
  for (const subscription of subscriptions) {
    subscription.stop()
  }

  if (subscriptions.length === 0) {
    return { settleTimedOut: false, timedOut: false }
  }

  const drained = Promise.allSettled(subscriptions.map((subscription) => subscription.done))
  const timedOut = await raceDeadline(drained, options.timeoutMs ?? resolveDrainTimeoutMs())

  if (!timedOut) {
    return { settleTimedOut: false, timedOut: false }
  }

  await Promise.allSettled(
    subscriptions.map((subscription) => subscription.abandon(WORKER_DRAIN_TIMEOUT_REASON)),
  )

  // The nack has already made the rows re-claimable, so this second wait buys
  // the queue nothing; it buys the *handlers* the chance to finish the writes
  // they are in the middle of before their transport disappears. Awaiting the
  // same `drained` promise is deliberate — a subscription's `done` resolves
  // only once its handler has settled and the loop has exited.
  const settleTimedOut = await raceDeadline(
    drained,
    options.settleMs ?? DEFAULT_WORKER_ABANDON_SETTLE_MS,
  )

  return { settleTimedOut, timedOut: true }
}

export type TeardownStep = {
  close: () => Promise<unknown>
  label: string
}

export type TeardownResult = {
  // The steps that had not finished when the deadline won. Empty on a clean
  // close, and named rather than counted so the log says which transport hung.
  unfinished: string[]
  // True when the hard deadline is what ended the teardown, rather than the
  // transports closing.
  timedOut: boolean
}

// The teardown, under a hard deadline. Steps run in order — the ordering above
// this call is what matters (nothing closes while a handler is still inside its
// settle window), and the ordering between transports is preserved here — but
// the whole sequence shares one budget, so a straggler already written off
// cannot hold shutdown open past the platform's grace.
//
// A step that rejects is logged and does not stop the ones after it: a failed
// close and a hung close both leave the process exiting, and the remaining
// transports still deserve the attempt.
export const closeTransportsWithDeadline = async (
  steps: readonly TeardownStep[],
  options: { timeoutMs?: number } = {},
): Promise<TeardownResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TEARDOWN_TIMEOUT_MS
  const unfinished = new Set(steps.map((step) => step.label))

  const closed = (async () => {
    for (const step of steps) {
      try {
        await step.close()
      } catch (error) {
        console.error(`[worker.teardown] ${step.label} failed to close`, error)
      }
      unfinished.delete(step.label)
    }
  })()

  const timedOut = await raceDeadline(closed, timeoutMs)
  if (timedOut) {
    console.warn(
      `[worker.teardown] hard deadline of ${timeoutMs}ms ended the shutdown with `
      + `${[...unfinished].join(', ')} still closing; a handler written off at the settle `
      + 'window is holding a client that will never come back, so the process exits now '
      + 'rather than being killed by the platform.',
    )
  }

  return { timedOut, unfinished: [...unfinished] }
}

// `SIGINT` and `SIGTERM` are both registered, so an operator pressing Ctrl-C
// during an orchestrator's `SIGTERM` drain used to call `stop()` twice and get
// two concurrent drains: the second `pool.end()` is rejected by pg
// ("Called end on pool more than once"), and because the signal handler calls
// `stop()` as a floating promise that surfaced as an unhandled rejection —
// which on this runtime ends the process abruptly, precisely the death the
// drain exists to avoid.
//
// Memoised, the second signal joins the first shutdown and waits for the same
// promise instead of starting another one. The promise is kept after it settles
// as well, so a late third caller gets the finished shutdown rather than a
// replay of it.
export const memoiseShutdown = (run: () => Promise<void>): (() => Promise<void>) => {
  let started: Promise<void> | null = null

  return (): Promise<void> => {
    started ??= run()
    return started
  }
}
