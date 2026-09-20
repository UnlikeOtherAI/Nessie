export type OutputFinalizationReason = 'empty_output' | 'length'

export type OutputFinalizationState = {
  noTools: boolean
  pending: boolean
  reason: OutputFinalizationReason | null
  used: boolean
}

export const EMPTY_OUTPUT_FINALIZATION_INSTRUCTION =
  'The provider returned no final answer. Give the user a concise final answer now, using only the completed work and tool results already in this conversation. Do not call tools or start new work.'

export const EMPTY_OUTPUT_TERMINAL_MESSAGE =
  'The model provider returned no final answer after a recovery attempt. Please try again; any completed work has been kept.'

export const OUTPUT_LENGTH_FINALIZATION_INSTRUCTION =
  'Your previous response reached the provider output limit. Give the user a concise final answer now, using only the completed work and tool results already in this conversation. Do not call tools or start new work.'

export class EmptyProviderResponseError extends Error {
  constructor() {
    super('Provider returned no final answer after one no-tools recovery attempt')
    this.name = 'EmptyProviderResponseError'
  }
}

export class ProviderOutputLimitError extends Error {
  constructor() {
    super('Provider repeatedly reached its output limit before completing the response')
    this.name = 'ProviderOutputLimitError'
  }
}

export const restoreOutputFinalizationState = (input: {
  lengthFinalizationPending?: boolean
  lengthFinalizationUsed?: boolean
  outputFinalizationPending?: boolean
  outputFinalizationNoTools?: boolean
  outputFinalizationReason?: OutputFinalizationReason | null
  outputFinalizationUsed?: boolean
}): OutputFinalizationState => {
  const used = input.outputFinalizationUsed ?? input.lengthFinalizationUsed ?? false
  return {
    noTools: input.outputFinalizationNoTools ?? true,
    pending: input.outputFinalizationPending ?? input.lengthFinalizationPending ?? false,
    reason: input.outputFinalizationReason ?? (used ? 'length' : null),
    used,
  }
}

export const outputFinalizationInstruction = (reason: OutputFinalizationReason, noTools = true): string =>
  !noTools
    ? 'Your previous tool-call response reached the provider output limit. Regenerate only the complete tool call needed to continue the already requested work. Do not repeat completed calls or begin unrelated work.'
    :
  reason === 'length'
    ? OUTPUT_LENGTH_FINALIZATION_INSTRUCTION
    : EMPTY_OUTPUT_FINALIZATION_INSTRUCTION

export const outputFinalizationTerminalText = (
  reason: OutputFinalizationReason,
  partialText: string,
): string => reason === 'length'
  ? [
    partialText.trim(),
    'The model provider reached its response limit again before it could finish. '
      + 'Completed work has been kept; please try again with a narrower request.',
  ].filter(Boolean).join('\n\n')
  : EMPTY_OUTPUT_TERMINAL_MESSAGE

export const outputFinalizationReasonFor = (input: {
  finishReason: string | null | undefined
  outputText: string
  toolCalls: readonly unknown[]
}): OutputFinalizationReason | null => {
  if (input.finishReason === 'length') return 'length'
  return !input.outputText.trim() && input.toolCalls.length === 0
    ? 'empty_output'
    : null
}

export const advanceOutputFinalization = (
  state: OutputFinalizationState,
  input: {
    finishReason: string | null | undefined
    outputText: string
    toolCalls: readonly unknown[]
  },
): { kind: 'recover'; reason: OutputFinalizationReason } | {
  kind: 'terminal'
  reason: OutputFinalizationReason
} | null => {
  const reason = outputFinalizationReasonFor(input)
  if (reason) {
    if (state.pending || state.used) {
      state.pending = false
      return { kind: 'terminal', reason: state.reason ?? reason }
    }
    state.used = true
    state.pending = true
    state.reason = reason
    // A length-stopped tool-call frame is not a complete operation. Do not
    // dispatch it; give the model one bounded chance to regenerate a complete
    // call under the same identity and effect ledger. Pure prose recovery is
    // deliberately no-tools so it cannot open new work.
    state.noTools = input.toolCalls.length === 0
    return { kind: 'recover', reason }
  }
  if (state.pending && input.toolCalls.length > 0 && !state.noTools) {
    state.pending = false
    // This is the one permitted regenerated tool batch after a truncated
    // frame. It will proceed through ordinary authorization and effect
    // idempotency; the original length-stopped batch was never dispatched.
    return null
  }
  if (state.pending && input.toolCalls.length > 0) {
    state.pending = false
    return { kind: 'terminal', reason: state.reason ?? 'length' }
  }
  return null
}
