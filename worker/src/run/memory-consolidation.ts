import type { PrismaClient } from '@prisma/client'
import { consolidateRunMemories, type CaptureConfig } from '@nessie/memory'
import { z } from 'zod'
import { enqueueQueueJob } from '../queue.js'

const TOPIC = 'memory.run.consolidate'

export const MEMORY_CONSOLIDATION_TOPIC = TOPIC
export const RunMemoryConsolidateJobPayloadSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
})
export type RunMemoryConsolidateJobPayload = z.infer<
  typeof RunMemoryConsolidateJobPayloadSchema
>

export const enqueueRunMemoryConsolidation = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: RunMemoryConsolidateJobPayload,
): Promise<boolean> =>
  enqueueQueueJob(prisma, {
    idempotencyKey: `memory-run-consolidate:${payload.runId}`,
    payload,
    topic: TOPIC,
  })

export const executeRunMemoryConsolidationJob = async (
  deps: { captureConfig: CaptureConfig },
  payload: RunMemoryConsolidateJobPayload,
): Promise<void> => {
  const result = await consolidateRunMemories(payload, deps.captureConfig)
  if (result.skippedReason) {
    console.warn(
      `[worker.memory] skipped run memory consolidation for ${payload.runId}: ${result.skippedReason}`,
    )
  }
}
