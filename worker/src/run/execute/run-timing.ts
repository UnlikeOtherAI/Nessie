import type { PrismaClient } from '@prisma/client'
import type { InvocationRecord } from '@nessie/runtime'

// Per-run, wall-clock-only latency breakdown recorded at every terminal state
// so a slow run is diagnosable without re-instrumenting the pipeline. It answers
// "where did the time go?" — queue wait vs model inference vs tool execution —
// and carries NO cost data (raw usage/cost is Ledger's domain, commercial
// rating is UOA's). Timestamps are reused from data the run already produces:
// `Run.createdAt` (≈ enqueue, since run.create + enqueue share one transaction),
// the claim instant, per-invocation `latencyMs`, and the loop's tool timing.
export type RunTimingSummary = {
  // Enqueue → claim: how long the job waited in the queue before a worker
  // picked it up. A large value points at worker saturation, not the model.
  queueWaitMs: number
  // Claim → terminal: total wall-clock the worker spent on this run.
  totalMs: number
  // Sum of model-invocation latencies (main loop + delegated sub-agents).
  inferenceMs: number
  inferenceCount: number
  // Aggregate tool-execution time. Tools within an iteration run concurrently,
  // so this sums per-tool spans and can exceed `totalMs` — it measures tool
  // work, not a wall-clock span.
  toolMs: number
  toolCount: number
}

export const summarizeRunTiming = (input: {
  enqueuedAt: Date
  claimedAt: Date
  finishedAt: Date
  invocations: InvocationRecord[]
  toolMs: number
  toolCount: number
}): RunTimingSummary => {
  const inferenceMs = input.invocations.reduce(
    (sum, inv) => sum + Math.max(0, inv.latencyMs ?? 0),
    0,
  )
  return {
    queueWaitMs: Math.max(0, input.claimedAt.getTime() - input.enqueuedAt.getTime()),
    totalMs: Math.max(0, input.finishedAt.getTime() - input.claimedAt.getTime()),
    inferenceMs,
    inferenceCount: input.invocations.length,
    toolMs: Math.max(0, Math.round(input.toolMs)),
    toolCount: input.toolCount,
  }
}

// Structured, queryable record of the run's stage timing. The Run row has no
// metadata column, so — like `run.budget_exhausted` and `run.failed` — the
// summary is stored as a `TaskEvent` (owner-only ops surface reads these).
export const recordRunTimingEvent = async (
  prisma: PrismaClient,
  input: {
    taskId: string
    runId: string
    outcome: 'completed' | 'failed'
    summary: RunTimingSummary
  },
): Promise<void> => {
  await prisma.taskEvent.create({
    data: {
      eventType: 'run.timing',
      payload: {
        outcome: input.outcome,
        runId: input.runId,
        ...input.summary,
      },
      taskId: input.taskId,
    },
  })
}
