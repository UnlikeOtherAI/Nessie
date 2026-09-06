import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'

export type QueueJob = {
  attempt: number
  enqueuedAt: string
  id: string
  maxAttempts: number
  payload: unknown
  topic: string
}

export type QueueHandlerContext = {
  // Aborted when the subscription's own signal aborts, when the job's lock is
  // lost, or when a drain BEGINS — not when it runs out of time. A long handler
  // (an agentic run) should reach its cancel/checkpoint path on it, and it only
  // gets to do that if it is told at the start of the grace window rather than
  // at the end of it.
  //
  // The abort is a warning, not a verdict: a handler that ignores it runs to
  // completion and is acked exactly as before. Only the deadline (`abandon`)
  // takes the job away.
  signal: AbortSignal
}

export type QueueHandler = (job: QueueJob, context: QueueHandlerContext) => Promise<void>

// The handle `subscribe` hands back. `stop()` is the graceful half of a drain:
// the loop takes no new job, the job it holds is told the drain has begun (its
// `context.signal` aborts), and `done` resolves once that job has been acked or
// nacked. `abandon()` is the ungraceful half, for a caller that has run out of
// patience.
export type QueueSubscription = {
  abandon(reason: string): Promise<void>
  done: Promise<void>
  stop(): void
}

export interface QueueProvider {
  acknowledge(jobId: string): Promise<void>
  nack(jobId: string, reason?: string): Promise<void>
  subscribe(
    topic: string,
    handler: QueueHandler,
    options?: { pollIntervalMs?: number; signal?: AbortSignal },
  ): QueueSubscription
}

type RawQueueJobRow = {
  attempt: number
  enqueued_at: Date
  id: string
  max_attempts: number
  payload: unknown
  topic: string
}

type LockRenewalState = { lost: boolean }

type InFlightJob = {
  // The single-writer gate over this job's terminal write. Exactly one of the
  // handler's own settle path and `abandon()`'s deadline nack may pass it; the
  // loser issues no statement at all. The flip is synchronous, so on a
  // single-threaded runtime the two can never both win however their pooled
  // connections interleave underneath — which is the whole point. The gate
  // replaces an `abandoned` flag that was read before the acknowledge was
  // issued and never re-checked, which left a window where a handler resolving
  // exactly as the deadline fired issued an ack while `abandon()` issued a
  // nack: nack committing last put a completed job back to `pending` for a
  // second worker to run, ack committing last flipped a row the successor had
  // already claimed to `done` mid-run.
  claimSettle: () => boolean
  controller: AbortController
  jobId: string
}

type SubscriptionState = { inFlight: InFlightJob | null }

const DEFAULT_LOCK_TTL_SECONDS = 5 * 60
const DEFAULT_POLL_INTERVAL_MS = 1_000
// Renew the lock at one third of its TTL so a handler that outlives the TTL
// (e.g. a long agentic run) keeps its claim and is never re-claimed and
// double-executed by another worker while still in flight.
const LOCK_RENEWAL_FRACTION = 3
// Two consecutive misses is one third of the TTL still unspent, so the handler
// is aborted while the lock it lost is (just) still nominally held, rather
// than after another worker has already been free to claim the row.
const MAX_CONSECUTIVE_LOCK_RENEWAL_FAILURES = 2
export const LOCK_RENEWAL_FAILED_REASON = 'lock_renewal_failed'
export const LOCK_EXPIRED_AT_MAX_ATTEMPTS_REASON = 'lock_expired_at_max_attempts'
// `signal.reason` when the abort came from the drain starting rather than from
// a lost lock or an exhausted deadline. A handler that wants to tell "wind down
// and hand the work back" apart from "you no longer hold this row" reads it.
export const DRAIN_STARTED_REASON = 'worker_drain_started'

const logQueueError = (message: string, error?: unknown): void => {
  if (error === undefined) {
    console.error(message)
    return
  }

  console.error(message, error)
}

const mapQueueJob = (row: RawQueueJobRow): QueueJob => ({
  attempt: row.attempt,
  enqueuedAt: row.enqueued_at.toISOString(),
  id: row.id,
  maxAttempts: row.max_attempts,
  payload: row.payload,
  topic: row.topic,
})

// Idempotent, set-based dead-lettering for the rows the claim's timeout arm now
// refuses: `processing`, past their lock, and already at `max_attempts`. Without
// it those rows sit `processing` forever once the claim stops re-taking them.
// Every worker may run it on its own interval — the UPDATE is a no-op for a row
// another instance already moved.
export const expireDeadQueueJobs = async (pool: Pool): Promise<number> => {
  const result = await pool.query(
    `
      UPDATE queue_jobs
      SET
        status = 'dead',
        error_message = $1,
        locked_until = NULL
      WHERE status = 'processing'
        AND locked_until IS NOT NULL
        AND locked_until < now()
        AND attempt >= max_attempts
    `,
    [LOCK_EXPIRED_AT_MAX_ATTEMPTS_REASON],
  )

  return result.rowCount ?? 0
}

export class PgQueueProvider implements QueueProvider {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      lockTtlSeconds?: number
    } = {},
  ) {}

  async acknowledge(jobId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE queue_jobs
        SET
          status = 'done',
          completed_at = now(),
          locked_until = NULL
        WHERE id = $1
      `,
      [jobId],
    )
  }

  async nack(jobId: string, reason?: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE queue_jobs
        SET
          status = CASE
            WHEN attempt >= max_attempts THEN 'dead'
            ELSE 'pending'
          END,
          error_message = $2,
          locked_until = NULL
        WHERE id = $1
      `,
      [jobId, reason ?? null],
    )
  }

  subscribe(
    topic: string,
    handler: QueueHandler,
    options: { pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): QueueSubscription {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const externalSignal = options.signal
    // The drain gate. Checked before every claim and used to cut the poll
    // delay short, so a stopping worker never sits out a full interval and
    // never takes a job it has no time left to run. It is also handed to
    // `runClaimedJob`, which forwards it to the in-flight job's own controller:
    // that is what makes `stop()` the moment the handler hears about the drain.
    const loopController = new AbortController()
    const state: SubscriptionState = { inFlight: null }

    const stop = (): void => {
      if (!loopController.signal.aborted) {
        loopController.abort()
      }
    }

    // The caller's signal still stops the subscription. It additionally reaches
    // the in-flight handler, through the per-job controller in `runClaimedJob`.
    if (externalSignal?.aborted) {
      stop()
    } else {
      externalSignal?.addEventListener('abort', stop, { once: true })
    }

    const done = (async () => {
      while (!loopController.signal.aborted) {
        let job: QueueJob | null = null
        try {
          job = await this.claimNextJob(topic)
        } catch (error) {
          logQueueError(`Queue subscription loop error for topic "${topic}"`, error)
          await delay(pollIntervalMs, undefined, { signal: loopController.signal })
            .catch(() => undefined)
          continue
        }

        if (!job) {
          await delay(pollIntervalMs, undefined, { signal: loopController.signal })
            .catch(() => undefined)
          continue
        }

        await this.runClaimedJob(job, handler, state, externalSignal, loopController.signal)
      }
    })().catch((error) => {
      logQueueError(`Queue subscription stopped unexpectedly for topic "${topic}"`, error)
    })

    return {
      abandon: async (reason: string): Promise<void> => {
        stop()
        const entry = state.inFlight
        if (!entry) {
          return
        }

        // Nack before the handler settles, on purpose: the caller is out of
        // time (a drain deadline), and the row must be re-claimable now rather
        // than after the five-minute lock TTL burns down.
        //
        // The controller is normally aborted already — `stop()` raised it when
        // the drain began — so this abort is the record of *why* the job was
        // taken away, not the first warning the handler gets. Taking the settle
        // below is what makes `runClaimedJob` discard the handler's own
        // outcome, so a straggler that finishes after this cannot ack a row
        // someone else now owns.
        entry.controller.abort(new Error(reason))

        // ...unless the handler got there first. A job whose handler resolved
        // in the same tick the deadline fired has already taken the settle, and
        // its acknowledge may still be in flight on another pooled connection:
        // nacking on top of it is the double-execution bug this gate exists to
        // close. The handler ran to completion, so `done` is the right outcome
        // and the deadline simply arrived too late to matter.
        if (!entry.claimSettle()) {
          return
        }

        await this.nack(entry.jobId, reason).catch((error) => {
          logQueueError(`Failed to nack abandoned queue job ${entry.jobId}`, error)
        })
      },
      done,
      stop,
    }
  }

  private async runClaimedJob(
    job: QueueJob,
    handler: QueueHandler,
    state: SubscriptionState,
    externalSignal: AbortSignal | undefined,
    drainSignal: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController()
    const forwardAbort = (): void => {
      controller.abort(externalSignal?.reason)
    }
    // A drain that has begun reaches the handler immediately — both the job
    // already running when `stop()` was called (the listener) and one the loop
    // claimed in the same tick the drain started (the `aborted` branch). Waiting
    // for the deadline instead gives a long agentic run no window at all in
    // which to checkpoint, and it simply dies when the platform escalates.
    const forwardDrain = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(DRAIN_STARTED_REASON))
      }
    }
    if (externalSignal?.aborted) {
      forwardAbort()
    } else {
      externalSignal?.addEventListener('abort', forwardAbort, { once: true })
    }
    if (drainSignal.aborted) {
      forwardDrain()
    } else {
      drainSignal.addEventListener('abort', forwardDrain, { once: true })
    }

    let settleClaimed = false
    const entry: InFlightJob = {
      claimSettle: (): boolean => {
        if (settleClaimed) {
          return false
        }

        settleClaimed = true
        return true
      },
      controller,
      jobId: job.id,
    }
    state.inFlight = entry
    const renewal: LockRenewalState = { lost: false }

    // Decide the outcome first, write it second. Running the handler and
    // issuing its statement in one `try` meant an acknowledge that itself threw
    // fell into the nack arm, and it left no single point at which the terminal
    // write could be claimed.
    let outcome: { kind: 'acknowledge' } | { kind: 'nack'; reason: string }
    try {
      await this.withLockRenewal(job.id, { controller, state: renewal }, () =>
        handler(job, { signal: controller.signal }),
      )

      // Lock loss outranks a completed handler: the claim is gone, so this
      // process may no longer speak for the row.
      //
      // Otherwise a handler that ran to completion is always acked — including
      // during a drain, where the old abort path returned without ack or nack
      // and left the row `processing` until its lock expired.
      outcome = renewal.lost
        ? { kind: 'nack', reason: LOCK_RENEWAL_FAILED_REASON }
        : { kind: 'acknowledge' }
    } catch (error) {
      outcome = {
        kind: 'nack',
        reason: renewal.lost
          ? LOCK_RENEWAL_FAILED_REASON
          : error instanceof Error
            ? error.message
            : 'Unknown queue failure',
      }
    }

    try {
      // The single writer wins here or nowhere. Losing means `abandon()` has
      // already nacked this row on the drain deadline and a successor may
      // already hold it, so this outcome is discarded rather than written —
      // exactly one of acknowledge and nack is ever applied to a job.
      if (!entry.claimSettle()) {
        return
      }

      if (outcome.kind === 'acknowledge') {
        await this.acknowledge(job.id)
      } else {
        await this.nack(job.id, outcome.reason)
      }
    } catch (error) {
      logQueueError(`Failed to settle queue job ${job.id}`, error)
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort)
      drainSignal.removeEventListener('abort', forwardDrain)
      state.inFlight = null
    }
  }

  private async renewLock(jobId: string, lockTtlSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE queue_jobs
        SET locked_until = now() + make_interval(secs => $2)
        WHERE id = $1
          AND status = 'processing'
      `,
      [jobId, lockTtlSeconds],
    )

    // Zero rows means the row is no longer ours to renew — swept, dead-lettered
    // or re-claimed by another instance. That is a renewal failure, not a no-op.
    return (result.rowCount ?? 0) > 0
  }

  private async withLockRenewal(
    jobId: string,
    lock: { controller: AbortController; state: LockRenewalState },
    run: () => Promise<void>,
  ): Promise<void> {
    const lockTtlSeconds = this.options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS
    const renewalIntervalMs = Math.max(
      1_000,
      Math.floor((lockTtlSeconds * 1000) / LOCK_RENEWAL_FRACTION),
    )
    let consecutiveFailures = 0
    let renewing = false
    const timer = setInterval(() => {
      if (renewing || lock.state.lost) {
        return
      }

      renewing = true
      void this.renewLock(jobId, lockTtlSeconds)
        .then((renewed) => {
          if (renewed) {
            consecutiveFailures = 0
            return
          }

          consecutiveFailures += 1
          logQueueError(
            `Lock renewal for queue job ${jobId} matched no processing row `
            + `(${consecutiveFailures} consecutive)`,
          )
        })
        .catch((error) => {
          consecutiveFailures += 1
          logQueueError(
            `Failed to renew lock for queue job ${jobId} (${consecutiveFailures} consecutive)`,
            error,
          )
        })
        .finally(() => {
          renewing = false
          if (lock.state.lost || consecutiveFailures < MAX_CONSECUTIVE_LOCK_RENEWAL_FAILURES) {
            return
          }

          lock.state.lost = true
          clearInterval(timer)
          logQueueError(
            `Lost the lock on queue job ${jobId} after ${consecutiveFailures} consecutive `
            + 'renewal failures; aborting the handler and releasing the job',
          )
          lock.controller.abort(new Error(LOCK_RENEWAL_FAILED_REASON))
        })
    }, renewalIntervalMs)
    // Renewal is a background keep-alive; it must never hold the event loop open.
    timer.unref()
    try {
      await run()
    } finally {
      clearInterval(timer)
    }
  }

  private async claimNextJob(topic: string): Promise<QueueJob | null> {
    const lockTtlSeconds = this.options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS
    const result = await this.pool.query<RawQueueJobRow>(
      `
        UPDATE queue_jobs
        SET
          status = 'processing',
          attempt = attempt + 1,
          locked_until = now() + make_interval(secs => $2),
          started_at = now()
        WHERE id = (
          SELECT id
          FROM queue_jobs
          WHERE topic = $1
            AND (
              (status = 'pending' AND enqueued_at <= now())
              OR (
                status = 'processing'
                AND locked_until IS NOT NULL
                AND locked_until < now()
                AND attempt < max_attempts
              )
            )
          ORDER BY enqueued_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, topic, payload, attempt, max_attempts, enqueued_at
      `,
      [topic, lockTtlSeconds],
    )

    return result.rows[0] ? mapQueueJob(result.rows[0]) : null
  }
}
