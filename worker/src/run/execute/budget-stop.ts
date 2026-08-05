import type { PrismaClient } from '@prisma/client'
import type { BudgetExhaustionReason } from '../agentic-loop.js'

// A run that ends at a policy ceiling — its effective run budget (explicit
// `Agent.runLimits` or the deployment backstop), the loop-detection guard, or
// the organization's `Budget` — rather than because the model decided it was
// done. Classifying the raw loop reason gives the run a stable, user-facing
// outcome instead of a silent empty reply.
export type RunStopReason =
  | 'iteration_limit'
  | 'tool_call_limit'
  | 'time_limit'
  | 'token_limit'
  | 'cost_limit'
  | 'org_budget_blocked'
  | 'repeated_tool_calls'

// How a run's work ended for checkpoint/metadata purposes: a hard stop reason,
// or `wound_down` — the model was told the run was ending (spec §3a) and chose
// to finish and hand over, so no system notice is posted; the checkpoint is
// still written quietly so a follow-up resumes with full state.
export type RunEndReason = RunStopReason | 'wound_down'

export type BudgetStopStats = {
  iterations: number
  toolCallsUsed: number
  totalTokensUsed: number
  totalCostCents: number
  wallclockMs: number
}

// How the user gets the work continued. Decided by the caller from structural
// facts (a checkpoint exists; the run is interactive; a continuation was
// enqueued) — never from message content.
export type StopContinuation =
  | { kind: 'auto'; part: number }
  | { kind: 'none' }
  | { kind: 'reply' }

const REASON_TO_STOP: Record<BudgetExhaustionReason, RunStopReason> = {
  cost: 'cost_limit',
  iterations: 'iteration_limit',
  loop_detected: 'repeated_tool_calls',
  org_budget_blocked: 'org_budget_blocked',
  tokens: 'token_limit',
  tool_calls: 'tool_call_limit',
  wallclock: 'time_limit',
}

export const classifyBudgetStop = (reason: BudgetExhaustionReason): RunStopReason =>
  REASON_TO_STOP[reason]

// Member-visible copy carries units of work only — never a currency figure.
// Local cost telemetry belongs in the TaskEvent payload and /ops/usage, not in
// a chat thread where members can read it.
const stopPhrase = (stop: RunStopReason, stats: BudgetStopStats): string => {
  switch (stop) {
    case 'iteration_limit':
      return `its reasoning-step limit (${stats.iterations} steps)`
    case 'tool_call_limit':
      return `its tool-call limit (${stats.toolCallsUsed} tool calls)`
    case 'time_limit':
      return `its time limit (${Math.round(stats.wallclockMs / 1000)}s)`
    case 'token_limit':
      return `its token limit (${stats.totalTokensUsed.toLocaleString('en-US')} tokens)`
    case 'cost_limit':
      return 'its configured cost limit'
    case 'org_budget_blocked':
      return 'the organization\'s budget'
    case 'repeated_tool_calls':
      return 'the loop-detection guard (a repeated tool-call loop)'
  }
}

const continuationSentence = (
  continuation: StopContinuation,
  hadPartialText: boolean,
): string => {
  switch (continuation.kind) {
    case 'auto':
      return `Continuing automatically from a saved checkpoint (part ${continuation.part}).`
    case 'reply':
      return 'Reply to continue from the saved checkpoint.'
    case 'none':
      return hadPartialText
        ? 'Reply to have me continue.'
        : 'Reply to have me try again, ideally with a narrower request.'
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
  continuation: StopContinuation = { kind: 'none' },
): string => {
  const stop = classifyBudgetStop(reason)
  const next = continuationSentence(continuation, hadPartialText)

  if (stop === 'org_budget_blocked') {
    return hadPartialText
      ? '_⚠️ I stopped here: this run was paused by the organization\'s budget — owners '
        + `have been notified. The answer above may be incomplete. ${next}_`
      : '⚠️ This run was paused by the organization\'s budget — owners have been '
        + `notified. ${next}`
  }

  return hadPartialText
    ? `_⚠️ I stopped here because this run reached ${stopPhrase(stop, stats)}. `
      + `The answer above may be incomplete. ${next}_`
    : `⚠️ This run stopped before I could finish: it reached ${stopPhrase(stop, stats)} `
      + `without producing an answer. ${next}`
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
  checkpointId?: string | null,
): Promise<void> => {
  await prisma.taskEvent.create({
    data: {
      eventType: 'run.budget_exhausted',
      payload: {
        checkpointId: checkpointId ?? null,
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
