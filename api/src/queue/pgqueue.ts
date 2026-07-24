import type { PrismaClient } from '@prisma/client'
import type {
  OrchestrateDecideJobPayload,
  PushDispatchJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'

// The raw queue insert + run.execute enqueue live in `@nessie/db` (shared with
// the worker and with the thread-serialization claim/drain seam); re-exported
// here so existing API call sites keep their import path.
export { enqueueQueueJob, enqueueRunExecution } from '@nessie/db'

export const enqueueOrchestrateDecide = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: OrchestrateDecideJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'orchestrate.decide',
  })
}

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
