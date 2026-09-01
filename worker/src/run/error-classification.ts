import {
  CREDITS_EXHAUSTED_USER_MESSAGE,
  isCreditsExhaustedError,
  providerFailureDetails,
} from '@nessie/runtime'
import { exponentialBackoffMs } from '@nessie/runtime/scheduling'
import { PrivateAgentPlacementError } from './execute/private-agent-placement.js'

export type FailoverReason =
  | 'auth'
  | 'auth_permanent'
  | 'credentials_missing'
  | 'credentials_scope'
  | 'rate_limit'
  | 'credits_exhausted'
  | 'billing'
  | 'context_overflow'
  | 'timeout'
  | 'overloaded'
  | 'model_not_found'
  | 'content_filter'
  | 'private_agent_placement'
  | 'format'
  | 'transient'
  | 'unknown'

export type RecoveryStrategy =
  | { action: 'retry'; delayMs: number }
  | { action: 'compact_and_retry' }
  | { action: 'fail_run' }
  | { action: 'surface_error'; userMessage: string }
  | { action: 'abort' }

export const userMessageForFailureReason = (reason: FailoverReason): string => {
  switch (reason) {
    case 'credentials_missing':
      return 'No API key is configured for the model provider. Ask a workspace owner to add the provider credential, then try again.'
    case 'credentials_scope':
      return 'The workspace AI service credential is not permitted to use the configured model. Ask a workspace owner to update its allowed model scope, then try again.'
    case 'auth_permanent':
      return 'The model provider rejected its API key. Ask a workspace owner to update the provider credential, then try again.'
    case 'auth':
      return 'The model provider could not authenticate this request. Ask a workspace owner to verify the provider credential, then try again.'
    case 'rate_limit':
      return 'The model provider is rate limited. Please try again shortly.'
    case 'credits_exhausted':
      return CREDITS_EXHAUSTED_USER_MESSAGE
    case 'billing':
      return 'The model provider reported a billing or quota problem. Ask a workspace owner to review the provider account, then try again.'
    case 'context_overflow':
      return 'This conversation is too long for the configured model. Start a new conversation or ask a shorter follow-up.'
    case 'timeout':
    case 'transient':
      return 'The model provider is temporarily unavailable. Please try again shortly.'
    case 'overloaded':
      return 'The model provider is overloaded. Please try again in a few minutes.'
    case 'model_not_found':
      return 'The configured model was not found. Ask a workspace owner to check the model configuration.'
    case 'content_filter':
      return 'The model provider blocked this request under its content policy. Try rephrasing it.'
    case 'private_agent_placement':
      return 'This private agent can only run in its private home conversation.'
    case 'format':
      return 'The model provider returned an invalid response. Please try again.'
    case 'unknown':
      return 'I could not complete that request because the assistant service encountered an unexpected error. Please try again; if it keeps happening, ask a workspace owner to check the worker logs.'
  }
}

export const classifyError = (error: unknown): FailoverReason => {
  if (error instanceof PrivateAgentPlacementError) return 'private_agent_placement'
  if (!(error instanceof Error)) return 'unknown'

  if (isCreditsExhaustedError(error)) {
    return 'credits_exhausted'
  }

  const message = error.message.toLowerCase()
  const providerFailure = providerFailureDetails(error)
  const statusMatch = message.match(/status[:\s]*(\d{3})/)
  const status = providerFailure?.statusCode
    ?? (statusMatch ? parseInt(statusMatch[1]!, 10) : null)

  if (
    (message.includes('api key') || message.includes('api_key'))
    && (message.includes('missing') || message.includes('not configured') || message.includes('required'))
  ) {
    return 'credentials_missing'
  }
  if (
    (message.includes('product app key') || message.includes('api key'))
    && message.includes('unsafe')
    && message.includes('scope')
  ) {
    return 'credentials_scope'
  }
  if (status === 401 || message.includes('unauthorized')) {
    if (message.includes('invalid') || message.includes('malformed') || message.includes('revoked')) {
      return 'auth_permanent'
    }
    return 'auth'
  }
  if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate_limit'
  }
  if (status === 402 || message.includes('billing') || message.includes('quota') || message.includes('insufficient')) {
    return 'billing'
  }
  if (
    message.includes('context') &&
    (message.includes('length') || message.includes('overflow') || message.includes('too long') || message.includes('maximum'))
  ) {
    return 'context_overflow'
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout') || message.includes('econnreset')) {
    return 'timeout'
  }
  if (status === 503 || message.includes('overloaded') || message.includes('service unavailable')) {
    return 'overloaded'
  }
  if (message.includes('model') && message.includes('not found')) {
    return 'model_not_found'
  }
  if (message.includes('content_filter') || message.includes('content policy') || message.includes('safety')) {
    return 'content_filter'
  }
  if (message.includes('json') && (message.includes('parse') || message.includes('unexpected'))) {
    return 'format'
  }
  if (status && status >= 500) {
    return 'transient'
  }

  return 'unknown'
}

export type RetryBudget = {
  remaining: number
  total: number
}

export const createRetryBudget = (total: number = 6): RetryBudget => ({
  remaining: total,
  total,
})

export const resolveRecovery = (
  reason: FailoverReason,
  attemptCount: number,
  retryBudget: RetryBudget,
): RecoveryStrategy => {
  // Ledger's invocation refusal is the commercial-credit authority. It is
  // terminal on this call and must reach normal run failure handling instead
  // of becoming an assistant-shaped synthetic completion.
  if (reason === 'credits_exhausted') {
    return { action: 'fail_run' }
  }

  if (retryBudget.remaining <= 0 && reason !== 'context_overflow') {
    return { action: 'surface_error', userMessage: 'Too many retries. Please try again later.' }
  }

  switch (reason) {
    case 'rate_limit':
      return attemptCount < 3
        ? { action: 'retry', delayMs: exponentialBackoffMs({ attempt: attemptCount, baseMs: 1000, capMs: 30_000 }) }
        : { action: 'surface_error', userMessage: userMessageForFailureReason(reason) }

    case 'overloaded':
      return attemptCount < 3
        ? { action: 'retry', delayMs: exponentialBackoffMs({ attempt: attemptCount, baseMs: 5000, capMs: 60_000 }) }
        : { action: 'surface_error', userMessage: userMessageForFailureReason(reason) }

    case 'transient':
    case 'timeout':
      return attemptCount < 2
        ? { action: 'retry', delayMs: exponentialBackoffMs({ attempt: attemptCount, baseMs: 2000, capMs: 30_000 }) }
        : { action: 'surface_error', userMessage: userMessageForFailureReason(reason) }

    case 'format':
      return attemptCount < 1
        ? { action: 'retry', delayMs: 500 }
        : { action: 'surface_error', userMessage: userMessageForFailureReason(reason) }

    case 'context_overflow':
      return { action: 'compact_and_retry' }

    case 'credentials_missing':
    case 'credentials_scope':
    case 'auth_permanent':
    case 'auth':
    case 'billing':
    case 'model_not_found':
    case 'content_filter':
    case 'private_agent_placement':
      return { action: 'surface_error', userMessage: userMessageForFailureReason(reason) }

    default:
      return { action: 'abort' }
  }
}
