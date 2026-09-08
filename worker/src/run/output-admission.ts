import type { ProviderMessage } from '@nessie/runtime'
import { estimateMessagesTokens } from './context-management.js'
import type { ContextPlan } from './context-window.js'

/** The input/output reservation for one provider call after context assembly. */
export type OutputAdmission = {
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
  const desiredOutputTokens = input.maxOutputTokens === undefined
    ? undefined
    : Math.min(input.maxOutputTokens, remainingRunTokens ?? input.maxOutputTokens)
  const contextOutputTokens = Math.max(0, input.contextPlan.availableTokens - transcriptTokens)
  return {
    projectedInputTokens,
    requiresCompaction: desiredOutputTokens !== undefined && desiredOutputTokens > contextOutputTokens,
    requestedOutputTokens: desiredOutputTokens === undefined
      ? undefined
      : Math.min(desiredOutputTokens, contextOutputTokens),
  }
}
