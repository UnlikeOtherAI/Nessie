// Per-run spend envelope, the metering that feeds it, and the graceful-stop
// trigger.
//
// The loop never spends its budget to the last token: it stops at 90% of the
// token / cost / wall-clock dimensions, and with one iteration or tool call
// still in hand. That reserved headroom is what pays for the checkpoint note
// (one bounded model call) and the terminal notice — a checkpoint cannot be
// produced *after* a cap has already fired.
//
// See docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §3.

import type { InvocationRecord } from '@nessie/runtime'

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

// Cache reads are re-served context, not fresh work, and providers price them
// accordingly (DeepSeek ~1/10th of input, OpenAI ~1/4). Metering them at full
// input price charged runs for context they barely paid for — the 2026-08-05
// incident killed a run at a claimed 504,738 tokens whose real spend was ~37%
// of that, 360,960 of it cache reads. The weight is resolved per run from the
// org's pricing rows, falling back to this default (see run-budget.ts).
export const DEFAULT_CACHE_READ_WEIGHT = 0.25

export type SpendTotals = {
  /** Provider-reported cache reads, summed. Reported; never metered raw. */
  cacheReadTokens: number
  /** What every token budget decision meters: input + output + weighted reads. */
  effectiveTokensUsed: number
  totalCostCents: number
  /** Raw provider `usage.totalTokens`, kept for ledger/telemetry parity. */
  totalTokensUsed: number
}

export const ZERO_SPEND: SpendTotals = {
  cacheReadTokens: 0,
  effectiveTokensUsed: 0,
  totalCostCents: 0,
  totalTokensUsed: 0,
}

// One invocation's budget-metered tokens. `totalTokens` is provider-reported as
// input + cacheRead + output, so the granular fields are what allow the cache
// discount; a provider that reports only a total degrades to that number rather
// than inventing a split.
const meterInvocationTokens = (
  usage: InvocationRecord['usage'],
  cacheReadWeight: number,
): number => {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return usage.totalTokens ?? 0
  }
  return (usage.inputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + Math.round(cacheReadWeight * (usage.cacheReadTokens ?? 0))
}

// Only USD provider-reported cost counts: a non-USD figure cannot be summed
// into a cents cap without a rate the worker does not have.
const usdCostCents = (invocation: InvocationRecord): number => {
  const cost = invocation.providerReportedCost
  if (!cost || cost.currency.toUpperCase() !== 'USD') return 0
  return Math.round(cost.amount * 100)
}

export const meterSpend = (
  invocations: InvocationRecord[],
  cacheReadWeight: number,
): SpendTotals =>
  invocations.reduce<SpendTotals>((totals, invocation) => ({
    cacheReadTokens: totals.cacheReadTokens + (invocation.usage.cacheReadTokens ?? 0),
    effectiveTokensUsed:
      totals.effectiveTokensUsed + meterInvocationTokens(invocation.usage, cacheReadWeight),
    totalCostCents: totals.totalCostCents + usdCostCents(invocation),
    totalTokensUsed: totals.totalTokensUsed + (invocation.usage.totalTokens ?? 0),
  }), ZERO_SPEND)

export type BudgetUsage = {
  effectiveTokensUsed: number
  elapsedMs: number
  iterations: number
  toolCallsUsed: number
  totalCostCents: number
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
  || overWindDownFraction(usage.effectiveTokensUsed, budget.maxTokens)
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

// Checked BEFORE an inference call is dispatched. The post-hoc token check
// below is a whole context too late: the 2026-08-05 incident's final call
// bought a 76k-token context after the cap was already in sight. A call whose
// raw context would carry the run past its FULL token limit is never sent — no
// 90% headroom here, because this boundary is the one that must never be
// crossed, and the reserve still belongs to the checkpoint.
export const stopBeforeInference = (
  budget: BudgetLimits,
  usage: { effectiveTokensUsed: number; projectedCallTokens: number },
): BudgetExhaustionReason | null => {
  const limit = budget.maxTokens
  if (typeof limit !== 'number' || limit <= 0) return null
  return usage.effectiveTokensUsed + usage.projectedCallTokens > limit ? 'tokens' : null
}

export const stopAfterInference = (
  budget: BudgetLimits,
  usage: Pick<BudgetUsage, 'effectiveTokensUsed' | 'totalCostCents'>,
): BudgetExhaustionReason | null => {
  if (overFraction(usage.effectiveTokensUsed, budget.maxTokens)) return 'tokens'
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
