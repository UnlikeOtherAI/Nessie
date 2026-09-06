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

export type QueueHandler = (job: QueueJob) => Promise<void>

export interface QueueProvider {
  acknowledge(jobId: string): Promise<void>
  nack(jobId: string, reason?: string): Promise<void>
  subscribe(
    topic: string,
    handler: QueueHandler,
    options?: { pollIntervalMs?: number; signal?: AbortSignal },
  ): void
}

type RawQueueJobRow = {
  attempt: number
  enqueued_at: Date
  id: string
  max_attempts: number
  payload: unknown
  topic: string
}

const DEFAULT_LOCK_TTL_SECONDS = 5 * 60
const DEFAULT_POLL_INTERVAL_MS = 1_000
// Renew the lock at one third of its TTL so a handler that outlives the TTL
// (e.g. a long agentic run) keeps its claim and is never re-claimed and
// double-executed by another worker while still in flight.
const LOCK_RENEWAL_FRACTION = 3

const logQueueError = (message: string, error: unknown): void => {
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
  ): void {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const signal = options.signal

    void (async () => {
      while (!signal?.aborted) {
        try {
          const job = await this.claimNextJob(topic)

          if (!job) {
            await delay(pollIntervalMs, undefined, { signal }).catch(() => undefined)
            continue
          }

          try {
            await this.withLockRenewal(job.id, () => handler(job))
            if (signal?.aborted) {
              return
            }

            await this.acknowledge(job.id)
          } catch (error) {
            if (signal?.aborted) {
              return
            }

            const reason = error instanceof Error ? error.message : 'Unknown queue failure'
            await this.nack(job.id, reason).catch((nackError) => {
              logQueueError(`Failed to nack queue job ${job.id}`, nackError)
            })
          }
        } catch (error) {
          if (signal?.aborted) {
            return
          }

          logQueueError(`Queue subscription loop error for topic "${topic}"`, error)
          await delay(pollIntervalMs, undefined, { signal }).catch(() => undefined)
        }
      }
    })().catch((error) => {
      if (signal?.aborted) {
        return
      }

      logQueueError(`Queue subscription stopped unexpectedly for topic "${topic}"`, error)
    })
  }

  private async renewLock(jobId: string, lockTtlSeconds: number): Promise<void> {
    await this.pool.query(
      `
        UPDATE queue_jobs
        SET locked_until = now() + make_interval(secs => $2)
        WHERE id = $1
          AND status = 'processing'
      `,
      [jobId, lockTtlSeconds],
    )
  }

  private async withLockRenewal<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    const lockTtlSeconds = this.options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS
    const renewalIntervalMs = Math.max(
      1_000,
      Math.floor((lockTtlSeconds * 1000) / LOCK_RENEWAL_FRACTION),
    )
    const timer = setInterval(() => {
      void this.renewLock(jobId, lockTtlSeconds).catch((error) => {
        logQueueError(`Failed to renew lock for queue job ${jobId}`, error)
      })
    }, renewalIntervalMs)
    // Renewal is a background keep-alive; it must never hold the event loop open.
    timer.unref()
    try {
      return await run()
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
              OR (status = 'processing' AND locked_until IS NOT NULL AND locked_until < now())
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
