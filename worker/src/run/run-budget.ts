import { AgentRunLimitsSchema, type AgentRunLimits } from '@nessie/schemas'
import type { BudgetLimits } from './loop-budget.js'

// Effective run budget.
//
// `Agent.effort` maps ONLY to the provider's reasoning effort; it is no longer a
// spend cap. Every dimension resolves as:
//
//   effective[dim] = agent.runLimits?.[dim] ?? backstop[dim]
//
// The backstop is deployment law (a safety envelope), not a user budget: it is
// invisible until an enormous run reaches it, and even then the work is
// checkpointed rather than lost. See
// docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §2.

const TOOL_TIMEOUT_MS = 75_000

export const RUN_BACKSTOP_DEFAULTS = {
  maxCostCents: 2_000,
  maxIterations: 1_000,
  maxTokens: 500_000,
  maxToolCalls: 2_000,
  maxWallclockMs: 2_700_000,
} as const

export const DEFAULT_AUTO_CONTINUATIONS = 2
export const DEFAULT_MAX_DELEGATES_PER_RUN = 16

type Env = Record<string, string | undefined>

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}

const nonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : fallback
}

export const resolveRunBackstop = (
  env: Env = process.env,
): Required<Omit<BudgetLimits, 'toolTimeoutMs'>> => ({
  maxCostCents: positiveInt(env['NESSIE_RUN_BACKSTOP_MAX_COST_CENTS'], RUN_BACKSTOP_DEFAULTS.maxCostCents),
  maxIterations: positiveInt(env['NESSIE_RUN_BACKSTOP_MAX_ITERATIONS'], RUN_BACKSTOP_DEFAULTS.maxIterations),
  maxTokens: positiveInt(env['NESSIE_RUN_BACKSTOP_MAX_TOKENS'], RUN_BACKSTOP_DEFAULTS.maxTokens),
  maxToolCalls: positiveInt(env['NESSIE_RUN_BACKSTOP_MAX_TOOL_CALLS'], RUN_BACKSTOP_DEFAULTS.maxToolCalls),
  maxWallclockMs: positiveInt(env['NESSIE_RUN_BACKSTOP_MAX_WALLCLOCK_MS'], RUN_BACKSTOP_DEFAULTS.maxWallclockMs),
})

// `Agent.runLimits` is operator-authored JSON. A malformed value is treated as
// "no explicit limits" (the backstop governs) rather than failing the run.
export const parseAgentRunLimits = (raw: unknown): AgentRunLimits | null => {
  if (raw === null || raw === undefined) return null
  const parsed = AgentRunLimitsSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const resolveEffectiveRunBudget = (
  runLimits: AgentRunLimits | null | undefined,
  env: Env = process.env,
): BudgetLimits => {
  const backstop = resolveRunBackstop(env)
  return {
    maxCostCents: runLimits?.maxCostCents ?? backstop.maxCostCents,
    maxIterations: runLimits?.maxIterations ?? backstop.maxIterations,
    maxTokens: runLimits?.maxTokens ?? backstop.maxTokens,
    maxToolCalls: runLimits?.maxToolCalls ?? backstop.maxToolCalls,
    maxWallclockMs: runLimits?.maxWallclockMs ?? backstop.maxWallclockMs,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  }
}

// Delegate sub-agents are a discovery fan-out, not a second full run: their
// envelope is fixed and small, and the parent run caps how many it may spawn.
export const DELEGATE_BUDGET: BudgetLimits = {
  maxCostCents: 100,
  maxIterations: 6,
  maxTokens: 30_000,
  maxToolCalls: 10,
  maxWallclockMs: 90_000,
  toolTimeoutMs: 25_000,
}

export const resolveMaxDelegatesPerRun = (env: Env = process.env): number =>
  nonNegativeInt(env['NESSIE_MAX_DELEGATES_PER_RUN'], DEFAULT_MAX_DELEGATES_PER_RUN)

export type DelegateGate = {
  /** False once the run has spent its sub-agent allowance. */
  tryAcquire: () => boolean
  overLimitMessage: () => string
}

// A structural cap, not a run-killer: an over-cap `delegate` call comes back as
// an ordinary failed tool result and the run carries on with its own tools.
export const createDelegateGate = (
  max: number = resolveMaxDelegatesPerRun(),
): DelegateGate => {
  let used = 0
  return {
    overLimitMessage: () =>
      `delegate failed: this run has already used its ${max} sub-agents. `
      + 'Finish the work yourself with the tools you have.',
    tryAcquire: () => {
      if (used >= max) return false
      used += 1
      return true
    },
  }
}

export const resolveAutoContinuations = (env: Env = process.env): number =>
  nonNegativeInt(env['NESSIE_RUN_AUTO_CONTINUATIONS'], DEFAULT_AUTO_CONTINUATIONS)
