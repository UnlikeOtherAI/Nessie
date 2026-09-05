import type { PrismaClient } from '@prisma/client'
import type {
  AttentionDispatchJobPayload,
  PushDispatchJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

// The raw queue insert, the `run.execute` enqueue and the `orchestrate.decide`
// chokepoint that stamps a single-member system DM's delegated identity all
// live in `@nessie/db` (shared with the worker, whose `send_message` tool wakes
// the same topic); re-exported here so existing API call sites keep their
// import path.
export {
  enqueueOrchestrateDecide,
  enqueueQueueJob,
  enqueueRunExecution,
} from '@nessie/db'

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
