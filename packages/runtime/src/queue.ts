import { randomUUID } from 'node:crypto'
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
  enqueue(
    topic: string,
    payload: unknown,
    options?: { delayMs?: number; idempotencyKey?: string },
  ): Promise<string>
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

  async enqueue(
    topic: string,
    payload: unknown,
    options: { delayMs?: number; idempotencyKey?: string } = {},
  ): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO queue_jobs (
          id,
          topic,
          payload,
          status,
          idempotency_key,
          attempt,
          max_attempts,
          enqueued_at
        )
        VALUES (
          $1,
          $2,
          $3::jsonb,
          'pending',
          $4,
          0,
          3,
          now() + make_interval(secs => $5 / 1000.0)
        )
        ON CONFLICT (idempotency_key)
        WHERE idempotency_key IS NOT NULL
        DO UPDATE SET topic = EXCLUDED.topic
        RETURNING id
      `,
      [
        randomUUID(),
        topic,
        JSON.stringify(payload),
        options.idempotencyKey ?? null,
        options.delayMs ?? 0,
      ],
    )

    return result.rows[0]!.id
  }

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
        let job: QueueJob | null
        try {
          job = await this.claimNextJob(topic)
        } catch (error) {
          if (signal?.aborted) {
            return
          }

          throw error
        }

        if (!job) {
          await delay(pollIntervalMs, undefined, { signal }).catch(() => undefined)
          continue
        }

        try {
          await handler(job)
          if (signal?.aborted) {
            return
          }

          await this.acknowledge(job.id)
        } catch (error) {
          if (signal?.aborted) {
            return
          }

          const reason = error instanceof Error ? error.message : 'Unknown queue failure'
          await this.nack(job.id, reason)
        }
      }
    })()
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
            AND status = 'pending'
            AND enqueued_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
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
