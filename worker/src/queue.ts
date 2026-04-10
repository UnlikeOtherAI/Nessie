import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export const enqueueQueueJob = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  input: {
    idempotencyKey?: string
    maxAttempts?: number
    payload: unknown
    topic: string
  },
): Promise<void> => {
  const encodedPayload = JSON.stringify(input.payload)
  const maxAttempts = input.maxAttempts ?? 3

  if (input.idempotencyKey) {
    await prisma.$executeRaw(
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
          now(),
          ${input.idempotencyKey}
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `,
    )
    return
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
        now()
      )
    `,
  )
}

export const enqueueRunExecution = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: RunExecuteJobPayload,
  idempotencyKey?: string,
): Promise<void> => {
  await enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'run.execute',
  })
}
