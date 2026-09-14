export type OutputFinalizationReason = 'empty_output' | 'length'

export type OutputFinalizationState = {
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

export const restoreOutputFinalizationState = (input: {
  lengthFinalizationPending?: boolean
  lengthFinalizationUsed?: boolean
  outputFinalizationPending?: boolean
  outputFinalizationReason?: OutputFinalizationReason | null
  outputFinalizationUsed?: boolean
}): OutputFinalizationState => {
  const used = input.outputFinalizationUsed ?? input.lengthFinalizationUsed ?? false
  return {
    pending: input.outputFinalizationPending ?? input.lengthFinalizationPending ?? false,
    reason: input.outputFinalizationReason ?? (used ? 'length' : null),
    used,
  }
}

export const outputFinalizationInstruction = (reason: OutputFinalizationReason): string =>
  reason === 'length'
    ? OUTPUT_LENGTH_FINALIZATION_INSTRUCTION
    : EMPTY_OUTPUT_FINALIZATION_INSTRUCTION

export const outputFinalizationTerminalText = (
  reason: OutputFinalizationReason,
  partialText: string,
): string => reason === 'length'
  ? [
    partialText.trim(),
    'I reached the response limit before completing the answer. Continue this run to finish.',
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
    return { kind: 'recover', reason }
  }
  if (state.pending && input.toolCalls.length > 0) {
    state.pending = false
    return { kind: 'terminal', reason: state.reason ?? 'length' }
  }
  return null
}
