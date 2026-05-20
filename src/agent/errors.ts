/**
 * src/agent/errors.ts — Agent-level error types for Nessie.
 */

export const AgentErrorCode = {
  ALL_BACKENDS_EXHAUSTED: 'ALL_BACKENDS_EXHAUSTED',
  INFERENCE_FAILED: 'INFERENCE_FAILED',
  INVALID_CONFIG: 'INVALID_CONFIG',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
} as const

export type AgentErrorCodeType = (typeof AgentErrorCode)[keyof typeof AgentErrorCode]

/**
 * Base error class for agent-level failures.
 * Carries a machine-readable code for programmatic error handling.
 */
export class AgentError extends Error {
  readonly code: AgentErrorCodeType | 'UNKNOWN'
  readonly cause: Error | Error[]

  constructor(
    message: string,
    options: { code?: string; cause?: Error | Error[] } = {},
  ) {
    super(message)
    this.name = 'AgentError'
    this.code = (options.code as AgentErrorCodeType) ?? 'UNKNOWN'
    this.cause = options.cause ?? []
  }
}

/**
 * Format an error (or any thrown value) into a human-readable string.
 *
 * Traverses `.cause` chains, deduplicates repeated messages, handles circular
 * references, and flattens `AgentError.cause` (Error | Error[]) into a single
 * deduplicated chain.
 *
 * @param err - Any thrown value (Error, string, number, object, etc.)
 * @returns A formatted, deduplicated error message string
 */
export function formatAgentError(err: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()

  function collect(current: unknown) {
    if (current == null || seen.has(current)) {
      return
    }
    seen.add(current)

    if (current instanceof Error) {
      const msg = current.message || current.name || 'Error'
      if (msg && !messages.includes(msg)) {
        messages.push(msg)
      }

      // Handle AgentError.cause which can be Error | Error[]
      if (current instanceof AgentError) {
        const causes = Array.isArray(current.cause) ? current.cause : [current.cause]
        for (const c of causes) {
          if (c instanceof Error) {
            collect(c)
          } else if (typeof c === 'string' && c && !messages.includes(c)) {
            messages.push(c)
          }
        }
      } else {
        // Standard Error.cause
        const cause = (current as Error & { cause?: unknown }).cause
        if (cause instanceof Error) {
          collect(cause)
        } else if (typeof cause === 'string' && cause && !messages.includes(cause)) {
          messages.push(cause)
        }
      }
    } else if (typeof current === 'string') {
      if (current && !messages.includes(current)) {
        messages.push(current)
      }
    } else if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'bigint') {
      const s = String(current)
      if (!messages.includes(s)) {
        messages.push(s)
      }
    } else {
      try {
        const s = JSON.stringify(current)
        if (s && !messages.includes(s)) {
          messages.push(s)
        }
      } catch {
        const s = Object.prototype.toString.call(current)
        if (!messages.includes(s)) {
          messages.push(s)
        }
      }
    }
  }

  collect(err)
  return messages.join(' | ')
}
