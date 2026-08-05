// Per-run spend envelope and the graceful-stop trigger.
//
// The loop never spends its budget to the last token: it stops at 90% of the
// token / cost / wall-clock dimensions, and with one iteration or tool call
// still in hand. That reserved headroom is what pays for the checkpoint note
// (one bounded model call) and the terminal notice — a checkpoint cannot be
// produced *after* a cap has already fired.
//
// See docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §3.

export type BudgetLimits = {
  maxIterations: number
  maxToolCalls: number
  maxWallclockMs: number
  maxTokens?: number
  maxCostCents?: number
  toolTimeoutMs?: number
}

export type BudgetExhaustionReason =
  | 'cost'
  | 'iterations'
  | 'loop_detected'
  // The organization/project/team `Budget` gate started refusing this run
  // mid-flight (see budget-gate.ts `createBudgetBlockedProbe`).
  | 'org_budget_blocked'
  | 'tokens'
  | 'tool_calls'
  | 'wallclock'

export const BUDGET_HEADROOM_FRACTION = 0.9

// Wind-down fires strictly before the graceful stop: the model is told the run
// is ending and given the remaining slice (80% → the 90% stop boundary) to
// deliver its best answer with what it already has. The hard stop then only
// fires when the model overruns even that — the instruction is the mechanism,
// the boundary is the insurance.
export const WIND_DOWN_FRACTION = 0.8

export type BudgetUsage = {
  elapsedMs: number
  iterations: number
  toolCallsUsed: number
  totalCostCents: number
  totalTokensUsed: number
}

// Countable dimensions reserve one whole unit rather than a fraction: "10% of
// 3 iterations" is not a usable reserve. A limit of 1 cannot reserve anything,
// so it still permits exactly one unit of work.
const reserveOne = (limit: number): number => Math.max(1, limit - 1)

// Countable wind-down needs one working turn in hand beyond the stop reserve;
// a limit too small to hold that never winds down — the stop boundary handles
// it directly.
const windDownAt = (limit: number): number => Math.max(1, limit - 2)

const overWindDownFraction = (used: number, limit: number | undefined): boolean =>
  typeof limit === 'number' && limit > 0 && used >= limit * WIND_DOWN_FRACTION

// Checked at the start of every iteration (all prior tool wrappers settled).
// True once ANY dimension enters its wind-down band — the loop injects the
// wind-down instruction exactly once and keeps running.
export const shouldWindDown = (budget: BudgetLimits, usage: BudgetUsage): boolean =>
  usage.elapsedMs >= budget.maxWallclockMs * WIND_DOWN_FRACTION
  || usage.iterations >= windDownAt(budget.maxIterations)
  || usage.toolCallsUsed >= windDownAt(budget.maxToolCalls)
  || overWindDownFraction(usage.totalTokensUsed, budget.maxTokens)
  || overWindDownFraction(usage.totalCostCents, budget.maxCostCents)

const overFraction = (used: number, limit: number | undefined): boolean =>
  typeof limit === 'number' && limit > 0 && used >= limit * BUDGET_HEADROOM_FRACTION

// Checked before an iteration starts. Token/cost verdicts deliberately live in
// `stopAfterInference` so a run that trips several dimensions at once is
// classified by the dimension that actually stopped it.
export const stopBeforeIteration = (
  budget: BudgetLimits,
  usage: Pick<BudgetUsage, 'elapsedMs' | 'iterations'>,
): BudgetExhaustionReason | null => {
  if (usage.elapsedMs >= budget.maxWallclockMs * BUDGET_HEADROOM_FRACTION) return 'wallclock'
  if (usage.iterations >= reserveOne(budget.maxIterations)) return 'iterations'
  return null
}

export const stopAfterInference = (
  budget: BudgetLimits,
  usage: Pick<BudgetUsage, 'totalCostCents' | 'totalTokensUsed'>,
): BudgetExhaustionReason | null => {
  if (overFraction(usage.totalTokensUsed, budget.maxTokens)) return 'tokens'
  if (overFraction(usage.totalCostCents, budget.maxCostCents)) return 'cost'
  return null
}

export const stopAfterToolBatch = (
  budget: BudgetLimits,
  usage: Pick<BudgetUsage, 'elapsedMs' | 'toolCallsUsed'>,
): BudgetExhaustionReason | null => {
  if (usage.toolCallsUsed >= reserveOne(budget.maxToolCalls)) return 'tool_calls'
  if (usage.elapsedMs >= budget.maxWallclockMs * BUDGET_HEADROOM_FRACTION) return 'wallclock'
  return null
}
