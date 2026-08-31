// One inference call plus its classified provider-error recovery.
//
// Split out of the agentic loop because it is a closed concern: it owns no loop
// state, only the transcript it may have to shrink and the run's shared retry
// budget. The loop calls it once per iteration and reads the result.

import type { InferenceResult, ProviderMessage } from '@nessie/runtime'
import { classifyError, resolveRecovery, type RetryBudget } from './error-classification.js'
import { isInferenceAbortedError } from './inference-abort.js'
import { trimConversationToFit } from './context-management.js'

const MAX_ATTEMPTS = 3
const MAX_OVERFLOW_TRIM_ATTEMPTS = 2

export const callInferenceWithRetry = async (
  messages: ProviderMessage[],
  runInference: (msgs: ProviderMessage[]) => Promise<InferenceResult>,
  retryBudget: RetryBudget,
  overflowTrimTarget: number,
): Promise<InferenceResult> => {
  let lastError: unknown
  let trimAttempts = 0

  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runInference(messages)
    } catch (error) {
      lastError = error
      // A deliberate abort is not a failure to recover from: retrying would
      // re-run the generation the user just cancelled, and surfacing it as
      // text would deliver an apology as the run's answer.
      if (isInferenceAbortedError(error)) {
        throw error
      }
      const reason = classifyError(error)
      const recovery = resolveRecovery(reason, attempt, retryBudget)

      if (recovery.action === 'retry') {
        retryBudget.remaining -= 1
        await new Promise((resolve) => setTimeout(resolve, recovery.delayMs))
        continue
      }

      if (recovery.action === 'compact_and_retry') {
        // Emergency path only: the provider rejected the request as too large
        // even though compaction runs between iterations. Truncate hard rather
        // than spend another model call inside a failing request.
        if (trimAttempts >= MAX_OVERFLOW_TRIM_ATTEMPTS) {
          throw new Error('Context overflow: unable to compact messages further')
        }
        trimAttempts += 1
        const trimmed = trimConversationToFit(messages, overflowTrimTarget)
        messages.length = 0
        messages.push(...trimmed)
        continue
      }

      if (recovery.action === 'fail_run') {
        throw error
      }

      if (recovery.action === 'surface_error') {
        return {
          correlationId: undefined,
          finishReason: 'error',
          invocations: [],
          model: '',
          outputText: recovery.userMessage,
          provider: 'openai',
          requestId: '',
          toolCalls: [],
        }
      }

      throw error
    }
  }

  throw lastError
}
