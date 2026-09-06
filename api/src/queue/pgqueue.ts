import type { PrismaClient } from '@prisma/client'
import type {
  AttentionDispatchJobPayload,
  PushDispatchJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

export const enqueuePushDispatch = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: PushDispatchJobPayload,
  idempotencyKey?: string,
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
