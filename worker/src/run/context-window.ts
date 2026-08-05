// Per-model context budget.
//
// The old flat 100k budget was wrong in both directions: it truncated a 400k
// model's run far too early and would have overflowed a 64k one. The window is
// now looked up per model, with a conservative default for unknown/custom ids,
// and discounted by a safety factor because the token count is a chars/4
// estimate (see context-management.ts) that under-counts code, JSON, and CJK.
//
// See docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §8.

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 100_000

// Discount applied to every window: the chars/4 estimator is approximate and a
// provider-side overflow costs a whole inference call to discover.
export const CONTEXT_ESTIMATE_SAFETY_FACTOR = 0.85

export const COMPACTION_TRIGGER_FRACTION = 0.8
export const COMPACTION_TARGET_FRACTION = 0.6

// Deliberately small and conservative: an under-stated window only compacts
// earlier, an over-stated one overflows. Matched by longest prefix.
const KNOWN_MODEL_WINDOWS: Array<[string, number]> = [
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-5', 400_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['claude', 200_000],
  ['deepseek', 128_000],
  ['kimi', 128_000],
  ['minimax', 128_000],
]

export const contextWindowForModel = (model: string | null | undefined): number => {
  const normalized = model?.trim().toLowerCase() ?? ''
  if (!normalized) return DEFAULT_CONTEXT_WINDOW_TOKENS
  let best: { prefix: string; window: number } | null = null
  for (const [prefix, window] of KNOWN_MODEL_WINDOWS) {
    if (!normalized.startsWith(prefix)) continue
    if (!best || prefix.length > best.prefix.length) best = { prefix, window }
  }
  return best?.window ?? DEFAULT_CONTEXT_WINDOW_TOKENS
}

export type ContextPlan = {
  /** Tokens available to the transcript once tool schemas are accounted for. */
  availableTokens: number
  /** Compaction fires when the transcript passes this. */
  triggerTokens: number
  /** Rebuild target for a compaction pass. */
  targetTokens: number
}

export const buildContextPlan = (input: {
  model: string | null | undefined
  toolSchemaTokens: number
}): ContextPlan => {
  const window = Math.floor(contextWindowForModel(input.model) * CONTEXT_ESTIMATE_SAFETY_FACTOR)
  // A pathological tool-schema payload must never produce a negative or absurd
  // transcript budget; keep at least a usable floor for the conversation.
  const availableTokens = Math.max(Math.floor(window * 0.25), window - input.toolSchemaTokens)
  return {
    availableTokens,
    targetTokens: Math.floor(availableTokens * COMPACTION_TARGET_FRACTION),
    triggerTokens: Math.floor(availableTokens * COMPACTION_TRIGGER_FRACTION),
  }
}

// Compaction costs a model call, so it is rate-limited within a run: at least
// two iterations between attempts, and a hard attempt ceiling.
export const COMPACTION_ITERATION_COOLDOWN = 2
export const MAX_COMPACTIONS_PER_RUN = 6

export type CompactionGovernor = {
  shouldAttempt: (input: { iteration: number; transcriptTokens: number }) => boolean
  recordAttempt: (iteration: number) => void
}

export const createCompactionGovernor = (plan: ContextPlan): CompactionGovernor => {
  let attempts = 0
  let lastAttemptIteration = -Infinity
  return {
    recordAttempt: (iteration) => {
      attempts += 1
      lastAttemptIteration = iteration
    },
    shouldAttempt: ({ iteration, transcriptTokens }) =>
      transcriptTokens > plan.triggerTokens
      && attempts < MAX_COMPACTIONS_PER_RUN
      && iteration - lastAttemptIteration >= COMPACTION_ITERATION_COOLDOWN,
  }
}
