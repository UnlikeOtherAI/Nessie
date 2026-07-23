import type { PrismaClient } from '@prisma/client'

// Owner-only ops read over the worker-emitted `run.timing` TaskEvents (see
// worker/src/run/execute/run-timing.ts). It answers "why was that run slow?"
// — queue wait vs inference vs tool time — without any cost data. Bounded by
// `limit` and scoped to the caller's organization via the Task relation.
export const DEFAULT_RUN_TIMING_LIMIT = 50
export const MAX_RUN_TIMING_LIMIT = 200

export type RunTimingRow = {
  runId: string | null
  taskId: string
  outcome: string | null
  queueWaitMs: number | null
  totalMs: number | null
  inferenceMs: number | null
  inferenceCount: number | null
  toolMs: number | null
  toolCount: number | null
  recordedAt: string
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

export const clampRunTimingLimit = (raw: string | undefined): number => {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RUN_TIMING_LIMIT
  return Math.min(parsed, MAX_RUN_TIMING_LIMIT)
}

export const getRecentRunTimings = async (
  prisma: PrismaClient,
  organizationId: string,
  limit: number = DEFAULT_RUN_TIMING_LIMIT,
): Promise<RunTimingRow[]> => {
  const events = await prisma.taskEvent.findMany({
    where: { eventType: 'run.timing', task: { organizationId } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { taskId: true, payload: true, createdAt: true },
  })

  return events.map((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    return {
      runId: stringOrNull(payload['runId']),
      taskId: event.taskId,
      outcome: stringOrNull(payload['outcome']),
      queueWaitMs: numberOrNull(payload['queueWaitMs']),
      totalMs: numberOrNull(payload['totalMs']),
      inferenceMs: numberOrNull(payload['inferenceMs']),
      inferenceCount: numberOrNull(payload['inferenceCount']),
      toolMs: numberOrNull(payload['toolMs']),
      toolCount: numberOrNull(payload['toolCount']),
      recordedAt: event.createdAt.toISOString(),
    }
  })
}
