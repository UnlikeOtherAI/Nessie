export type FailoverReason =
  | 'auth'
  | 'auth_permanent'
  | 'rate_limit'
  | 'billing'
  | 'context_overflow'
  | 'timeout'
  | 'overloaded'
  | 'model_not_found'
  | 'content_filter'
  | 'format'
  | 'transient'
  | 'unknown'

export type RecoveryStrategy =
  | { action: 'retry'; delayMs: number }
  | { action: 'compact_and_retry' }
  | { action: 'surface_error'; userMessage: string }
  | { action: 'abort' }

export const classifyError = (error: unknown): FailoverReason => {
  if (!(error instanceof Error)) return 'unknown'

  const message = error.message.toLowerCase()
  const statusMatch = message.match(/status[:\s]*(\d{3})/)
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : null

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
  if (retryBudget.remaining <= 0 && reason !== 'context_overflow') {
    return { action: 'surface_error', userMessage: 'Too many retries. Please try again later.' }
  }

  switch (reason) {
    case 'rate_limit':
      return attemptCount < 3
        ? { action: 'retry', delayMs: Math.min(1000 * 2 ** attemptCount, 30_000) }
        : { action: 'surface_error', userMessage: 'Rate limited by the model provider. Try again shortly.' }

    case 'overloaded':
      return attemptCount < 3
        ? { action: 'retry', delayMs: Math.min(5000 * 2 ** attemptCount, 60_000) }
        : { action: 'surface_error', userMessage: 'The model provider is overloaded. Try again in a few minutes.' }

    case 'transient':
    case 'timeout':
      return attemptCount < 2
        ? { action: 'retry', delayMs: Math.min(2000 * 2 ** attemptCount, 30_000) }
        : { action: 'surface_error', userMessage: 'The model provider is temporarily unavailable.' }

    case 'format':
      return attemptCount < 1
        ? { action: 'retry', delayMs: 500 }
        : { action: 'surface_error', userMessage: 'Received a malformed response from the model.' }

    case 'context_overflow':
      return { action: 'compact_and_retry' }

    case 'auth':
      return { action: 'surface_error', userMessage: 'Authentication failed with the model provider. Check API key configuration.' }

    case 'auth_permanent':
      return { action: 'surface_error', userMessage: 'Invalid API key. Please update your provider credentials.' }

    case 'billing':
      return { action: 'surface_error', userMessage: 'Billing issue with the model provider.' }

    case 'model_not_found':
      return { action: 'surface_error', userMessage: 'The configured model was not found.' }

    case 'content_filter':
      return { action: 'surface_error', userMessage: 'The response was blocked by content policy.' }

    default:
      return { action: 'abort' }
  }
}
