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
  readonly code: AgentErrorCodeType
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