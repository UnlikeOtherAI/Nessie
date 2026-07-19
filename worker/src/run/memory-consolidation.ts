import type { PrismaClient } from '@prisma/client'
import { consolidateRunMemories, type CaptureConfig } from '@nessie/memory'
import {
  attributionFromActorContext,
  completeLedgerAttribution,
} from '@nessie/runtime'
import {
  RunMemoryConsolidateJobPayloadSchema,
  type RunExecuteJobPayload,
  type RunMemoryConsolidateJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'

const TOPIC = 'memory.run.consolidate'
const SYSTEM_COMPONENT = 'memory-consolidation'

export const MEMORY_CONSOLIDATION_TOPIC = TOPIC

export const buildRunMemoryConsolidationJobPayload = (
  source: RunExecuteJobPayload,
): RunMemoryConsolidateJobPayload => {
  const requestId = `${SYSTEM_COMPONENT}:${source.runId}`
  const attribution = completeLedgerAttribution({
    ...attributionFromActorContext(source.actorContext, {
      agentId: null,
      agentKind: 'system',
      runId: null,
      systemComponent: SYSTEM_COMPONENT,
    }),
    agentId: null,
    agentKind: 'system',
    requestId,
    runId: null,
    taskId: source.taskId,
    threadId: source.threadId,
    toolCallId: `${requestId}:capture`,
  })

  return RunMemoryConsolidateJobPayloadSchema.parse({
    origin: {
      actorId: attribution.agentId,
      actorType: 'system',
      agentId: attribution.agentId,
      agentKind: 'system',
      organizationId: attribution.organizationId,
      userId: attribution.userId,
      teamId: attribution.teamId,
      ...(attribution.projectId
        ? { projectId: attribution.projectId }
        : {}),
      channelId: attribution.channelId,
      threadId: source.threadId,
      taskId: source.taskId,
      runId: attribution.runId,
      requestId,
      ...(attribution.correlationId
        ? { correlationId: attribution.correlationId }
        : {}),
      systemComponent: SYSTEM_COMPONENT,
      toolCallId: attribution.toolCallId,
    },
    runId: source.runId,
    source: {
      agentId: source.agentId,
      organizationId: attribution.organizationId,
      userId: attribution.userId,
      teamId: attribution.teamId,
      ...(attribution.projectId
        ? { projectId: attribution.projectId }
        : {}),
      channelId: attribution.channelId,
      threadId: source.threadId,
      taskId: source.taskId,
    },
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
  const parsed = RunMemoryConsolidateJobPayloadSchema.parse(payload)
  const result = await consolidateRunMemories(parsed, deps.captureConfig)
  if (result.skippedReason) {
    console.warn(
      `[worker.memory] skipped run memory consolidation for ${parsed.runId}: ${result.skippedReason}`,
    )
  }
}
