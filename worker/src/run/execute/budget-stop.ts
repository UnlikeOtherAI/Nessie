import type { PrismaClient } from '@prisma/client'
import type { BudgetExhaustionReason } from '../agentic-loop.js'

// A run that ends because the agentic loop hit a per-effort cap (rather than the
// model deciding it was done). Classifying the raw loop reason gives the run a
// stable, user-facing outcome instead of a silent empty reply — the "single
// worst UX failure mode" the harness-v2 plan calls out.
export type RunStopReason =
  | 'iteration_limit'
  | 'tool_call_limit'
  | 'time_limit'
  | 'token_limit'
  | 'cost_limit'
  | 'repeated_tool_calls'

export type BudgetStopStats = {
  iterations: number
  toolCallsUsed: number
  totalTokensUsed: number
  totalCostCents: number
  wallclockMs: number
}

const REASON_TO_STOP: Record<BudgetExhaustionReason, RunStopReason> = {
  cost: 'cost_limit',
  iterations: 'iteration_limit',
  loop_detected: 'repeated_tool_calls',
  tokens: 'token_limit',
  tool_calls: 'tool_call_limit',
  wallclock: 'time_limit',
}

const STOP_LABELS: Record<RunStopReason, string> = {
  cost_limit: 'cost limit',
  iteration_limit: 'reasoning-step limit',
  repeated_tool_calls: 'loop-detection guard',
  time_limit: 'time limit',
  token_limit: 'token limit',
  tool_call_limit: 'tool-call limit',
}

export const classifyBudgetStop = (reason: BudgetExhaustionReason): RunStopReason =>
  REASON_TO_STOP[reason]

const stopDetail = (stop: RunStopReason, stats: BudgetStopStats): string => {
  switch (stop) {
    case 'iteration_limit':
      return `${stats.iterations} reasoning steps`
    case 'tool_call_limit':
      return `${stats.toolCallsUsed} tool calls`
    case 'time_limit':
      return `${Math.round(stats.wallclockMs / 1000)}s`
    case 'token_limit':
      return `${stats.totalTokensUsed.toLocaleString('en-US')} tokens`
    case 'cost_limit':
      return `~$${(stats.totalCostCents / 100).toFixed(2)}`
    case 'repeated_tool_calls':
      return 'a repeated tool-call loop'
  }
}

// Human-readable notice appended to (or standing in for) the run's reply so the
// user always knows the run stopped at a limit and why. `hadPartialText`
// switches between "the answer above is incomplete" and "no answer was
// produced" framing.
export const buildBudgetStopNotice = (
  reason: BudgetExhaustionReason,
  stats: BudgetStopStats,
  hadPartialText: boolean,
): string => {
  const stop = classifyBudgetStop(reason)
  const label = STOP_LABELS[stop]
  const detail = stopDetail(stop, stats)
  return hadPartialText
    ? `_⚠️ I stopped here because this run reached its ${label} (${detail}). `
      + 'The answer above may be incomplete — reply to have me continue._'
    : `⚠️ This run stopped before I could finish: it reached its ${label} (${detail}) `
      + 'without producing an answer. Reply to have me try again, ideally with a '
      + 'narrower request.'
}

// Structured, queryable record of the classified stop reason on the run's task.
// The Run row has no metadata/error column, so the outcome is recorded as a
// TaskEvent (mirroring the `run.failed` event the failure path writes).
export const recordBudgetStopEvent = async (
  prisma: PrismaClient,
  taskId: string,
  reason: BudgetExhaustionReason,
  stats: BudgetStopStats,
  hadPartialText: boolean,
): Promise<void> => {
  await prisma.taskEvent.create({
    data: {
      eventType: 'run.budget_exhausted',
      payload: {
        costCents: stats.totalCostCents,
        hadPartialText,
        iterations: stats.iterations,
        rawReason: reason,
        stopReason: classifyBudgetStop(reason),
        tokensUsed: stats.totalTokensUsed,
        toolCallsUsed: stats.toolCallsUsed,
        wallclockMs: stats.wallclockMs,
      },
      taskId,
    },
  })
}
