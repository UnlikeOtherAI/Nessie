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
  abandonedReason: string | null
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
        // the drain began — so this is the record of *why* the job was taken
        // away, not the first warning the handler gets. `abandonedReason` is
        // what makes `runClaimedJob` discard the handler's own outcome, so a
        // straggler that finishes after this cannot ack a row someone else now
        // owns.
        entry.abandonedReason = reason
        entry.controller.abort(new Error(reason))
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

    const entry: InFlightJob = { abandonedReason: null, controller, jobId: job.id }
    state.inFlight = entry
    const renewal: LockRenewalState = { lost: false }

    try {
      try {
        await this.withLockRenewal(job.id, { controller, state: renewal }, () =>
          handler(job, { signal: controller.signal }),
        )

        if (entry.abandonedReason) {
          return
        }

        // Lock loss outranks a completed handler: the claim is gone, so this
        // process may no longer speak for the row.
        if (renewal.lost) {
          await this.nack(job.id, LOCK_RENEWAL_FAILED_REASON)
          return
        }

        // A handler that ran to completion is always acked — including during a
        // drain, where the old abort path returned without ack or nack and left
        // the row `processing` until its lock expired.
        await this.acknowledge(job.id)
      } catch (error) {
        if (entry.abandonedReason) {
          return
        }

        const reason = renewal.lost
          ? LOCK_RENEWAL_FAILED_REASON
          : error instanceof Error
            ? error.message
            : 'Unknown queue failure'
        await this.nack(job.id, reason)
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
