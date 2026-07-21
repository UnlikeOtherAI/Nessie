import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  type CommsSubscriptionsRenewJobPayload,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

export const enqueueQueueJob = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  input: {
    idempotencyKey?: string
    maxAttempts?: number
    payload: unknown
    topic: string
  },
): Promise<boolean> => {
  const encodedPayload = JSON.stringify(input.payload)
  const maxAttempts = input.maxAttempts ?? 3

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
          now(),
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
        now()
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

/**
 * Enqueue the communications subscription-renewal sweep. The caller supplies a
 * window-bucketed idempotency key so multiple worker replicas ticking their
 * interval do not stack duplicate sweeps for the same window.
 */
export const enqueueCommsSubscriptionsRenew = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: CommsSubscriptionsRenewJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  })
}
