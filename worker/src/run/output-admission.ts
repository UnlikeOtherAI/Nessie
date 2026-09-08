import type { ProviderMessage } from '@nessie/runtime'
import { estimateMessagesTokens } from './context-management.js'
import type { ContextPlan } from './context-window.js'

/** The input/output reservation for one provider call after context assembly. */
export type OutputAdmission = {
  /** A tighter transcript target when the run envelope, not model context, is full. */
  compactionTargetTokens?: number
  projectedInputTokens: number
  requestedOutputTokens: number | undefined
  requiresCompaction: boolean
}

export const resolveOutputAdmission = (input: {
  contextPlan: ContextPlan
  effectiveTokensUsed: number
  maxOutputTokens?: number
  maxRunTokens?: number
  messages: ProviderMessage[]
  toolSchemaTokens: number
}): OutputAdmission => {
  const transcriptTokens = estimateMessagesTokens(input.messages)
  const projectedInputTokens = transcriptTokens + input.toolSchemaTokens
  const remainingRunTokens = typeof input.maxRunTokens === 'number'
    ? Math.max(0, input.maxRunTokens - input.effectiveTokensUsed - projectedInputTokens)
    : undefined
  const remainingAfterToolSchemas = typeof input.maxRunTokens === 'number'
    ? Math.max(0, input.maxRunTokens - input.effectiveTokensUsed - input.toolSchemaTokens)
    : undefined
  const desiredOutputTokens = input.maxOutputTokens === undefined
    ? undefined
    : Math.min(input.maxOutputTokens, remainingRunTokens ?? input.maxOutputTokens)
  const contextOutputTokens = Math.max(0, input.contextPlan.availableTokens - transcriptTokens)
  // A full tool schema can never be compacted. If it alone consumes the
  // remaining run allowance, a utility call would only spend more budget
  // before reaching the same stop. Otherwise, a zero output allowance may be
  // recoverable by folding the retained transcript even when the physical
  // context window has ample room.
  const canRecoverZeroOutputWithCompaction = desiredOutputTokens === 0
    && remainingAfterToolSchemas !== undefined
    && remainingAfterToolSchemas > 0
    && transcriptTokens > 0
  const runBudgetCompactionTarget = canRecoverZeroOutputWithCompaction
    // Leave half of the allowance after schemas for the next answer. The
    // ordinary context target can be much larger than a modest run budget.
    ? Math.min(input.contextPlan.targetTokens, Math.floor(remainingAfterToolSchemas! / 2))
    : undefined
  return {
    ...(runBudgetCompactionTarget !== undefined
      ? { compactionTargetTokens: runBudgetCompactionTarget }
      : {}),
    projectedInputTokens,
    requiresCompaction: canRecoverZeroOutputWithCompaction
      || (desiredOutputTokens !== undefined && desiredOutputTokens > contextOutputTokens),
    requestedOutputTokens: desiredOutputTokens === undefined
      ? undefined
      : Math.min(desiredOutputTokens, contextOutputTokens),
  }
}
