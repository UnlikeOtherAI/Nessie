import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'

// Prisma-level queue enqueue primitives shared by the API and the worker. The
// queue is a plain Postgres table (`queue_jobs`); inserting the job row inside
// the caller's transaction is what makes run creation + enqueue atomic.
// Both apps' queue modules re-export these so existing call sites keep their
// import paths.

export const enqueueQueueJob = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  input: {
    delayMs?: number
    idempotencyKey?: string
    maxAttempts?: number
    payload: unknown
    topic: string
  },
): Promise<boolean> => {
  const encodedPayload = JSON.stringify(input.payload)
  const maxAttempts = input.maxAttempts ?? 3
  const delayMs = input.delayMs ?? 0

  if (input.idempotencyKey) {
    const inserted = await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO queue_jobs (
          topic,
          payload,
          status,
          attempt,
          max_attempts,
          enqueued_at,
          idempotency_key
        )
        VALUES (
          ${input.topic},
          ${encodedPayload}::jsonb,
          'pending',
          0,
          ${maxAttempts},
          now() + (${delayMs} * interval '1 millisecond'),
          ${input.idempotencyKey}
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `,
    )

    return Number(inserted) > 0
  }

  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO queue_jobs (
        topic,
        payload,
        status,
        attempt,
        max_attempts,
        enqueued_at
      )
      VALUES (
        ${input.topic},
        ${encodedPayload}::jsonb,
        'pending',
        0,
        ${maxAttempts},
        now() + (${delayMs} * interval '1 millisecond')
      )
    `,
  )

  return true
}

export const enqueueRunExecution = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: RunExecuteJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'run.execute',
  })
}
