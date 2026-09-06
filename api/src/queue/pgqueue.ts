import type { PrismaClient } from '@prisma/client'
import type {
  AttentionDispatchJobPayload,
  PushDispatchJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

/**
 * Enqueue one `push.dispatch` job. The idempotency key is REQUIRED, not
 * optional: `enqueue` upserts on it, so it is what stops a retried caller
 * creating a second job for one notification (horizontal-scaling invariant 3).
 * Derive it from the notification's own identity — `push:<messageId>` — never
 * from a clock reading or a random value.
 */
export const enqueuePushDispatch = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: PushDispatchJobPayload,
  idempotencyKey: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'push.dispatch',
  })
}

export const enqueueAttentionDispatch = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: AttentionDispatchJobPayload,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey: `attention:${payload.alertId}`,
    payload,
    topic: 'attention.dispatch',
  })
}
