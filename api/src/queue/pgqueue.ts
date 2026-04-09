import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export const enqueueRunExecution = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: RunExecuteJobPayload,
  idempotencyKey?: string,
): Promise<void> => {
  const encodedPayload = JSON.stringify(payload)

  if (idempotencyKey) {
    // With idempotency: skip if a job with this key already exists
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
          'run.execute',
          ${encodedPayload}::jsonb,
          'pending',
          0,
          3,
          now(),
          ${idempotencyKey}
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `,
    )
  } else {
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
          'run.execute',
          ${encodedPayload}::jsonb,
          'pending',
          0,
          3,
          now()
        )
      `,
    )
  }
}
