import type { PrismaClient } from '@prisma/client'
import {
  consolidateRunMemories,
  deriveMemoryConsolidationInferenceOrigin,
  parseAndVerifyMemoryConsolidationJobPayload,
  type CaptureConfig,
} from '@nessie/memory'
import {
  attributionFromActorContext,
  LedgerAttributionError,
} from '@nessie/runtime'
import {
  MemoryConsolidationSourceSchema,
  type RunExecuteJobPayload,
  type RunMemoryConsolidateJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'

const TOPIC = 'memory.run.consolidate'

export const MEMORY_CONSOLIDATION_TOPIC = TOPIC

export const buildRunMemoryConsolidationJobPayload = (
  source: RunExecuteJobPayload,
): RunMemoryConsolidateJobPayload => {
  const launch = attributionFromActorContext(source.actorContext)
  const missing = [
    !launch.userId ? 'user_id' : null,
    !launch.teamId ? 'team_id' : null,
  ].filter((field): field is string => field !== null)
  if (missing.length > 0) {
    throw new LedgerAttributionError(missing)
  }
  const immutableSource = MemoryConsolidationSourceSchema.parse({
    agentId: source.agentId,
    channelId: launch.channelId,
    organizationId: launch.organizationId,
    ...(launch.projectId ? { projectId: launch.projectId } : {}),
    taskId: source.taskId,
    teamId: launch.teamId,
    threadId: source.threadId,
    userId: launch.userId,
  })
  const origin = deriveMemoryConsolidationInferenceOrigin({
    runId: source.runId,
    source: immutableSource,
  })

  return parseAndVerifyMemoryConsolidationJobPayload({
    origin,
    runId: source.runId,
    source: immutableSource,
    taskId: source.taskId,
  })
}

export const enqueueRunMemoryConsolidation = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  source: RunExecuteJobPayload,
): Promise<boolean> => {
  const payload = buildRunMemoryConsolidationJobPayload(source)

  return enqueueQueueJob(prisma, {
    idempotencyKey: `memory-run-consolidate:${payload.runId}`,
    payload,
    topic: TOPIC,
  })
}

export const executeRunMemoryConsolidationJob = async (
  deps: { captureConfig: CaptureConfig },
  payload: unknown,
): Promise<void> => {
  const parsed = parseAndVerifyMemoryConsolidationJobPayload(payload)
  const result = await consolidateRunMemories(parsed, deps.captureConfig)
  if (result.skippedReason) {
    console.warn(
      `[worker.memory] skipped run memory consolidation for ${parsed.runId}: ${result.skippedReason}`,
    )
  }
}
