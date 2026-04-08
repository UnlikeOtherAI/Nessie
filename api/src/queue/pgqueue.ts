import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export const enqueueRunExecution = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: RunExecuteJobPayload,
): Promise<void> => {
  const encodedPayload = JSON.stringify(payload)

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
