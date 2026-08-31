import type { PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'

type QueueClient = Pick<PrismaClient, '$executeRaw'>

export const enqueueCallRingDispatch = async (
  prisma: QueueClient,
  input: { callId: string; userId: string },
): Promise<boolean> => enqueueQueueJob(prisma, {
  idempotencyKey: `call:ring-dispatch:${input.callId}:${input.userId}`,
  payload: input,
  topic: 'call.ring-dispatch',
})

export const enqueueCallRingCancellation = async (
  prisma: QueueClient,
  input: { callId: string; userIds: string[] },
): Promise<void> => {
  for (const userId of new Set(input.userIds)) {
    await enqueueQueueJob(prisma, {
      idempotencyKey: `call:ring-cancel:${input.callId}:${userId}`,
      payload: { callId: input.callId, userId },
      topic: 'call.ring-cancel',
    })
  }
}
