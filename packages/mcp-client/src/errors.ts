/**
 * Structured error hierarchy for MCP client operations.
 *
 * Every error thrown by `McpClientManager` is an instance of `McpError` and
 * carries a discriminant in `kind` so callers can branch without resorting to
 * fragile `instanceof` chains or string matching.
 */

export type McpErrorKind =
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'PROTOCOL'
  | 'AUTH'
  | 'NOT_CONNECTED'

export abstract class McpError extends Error {
  abstract readonly kind: McpErrorKind

  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = new.target.name
    if (options?.cause !== undefined) {
      // ES2022 Error has `cause` but our target may not narrow it
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

export class McpTimeoutError extends McpError {
  readonly kind = 'TIMEOUT' as const

  constructor(message: string, public readonly timeoutMs: number, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export class McpTransportError extends McpError {
  readonly kind = 'TRANSPORT' as const

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export class McpProtocolError extends McpError {
  readonly kind = 'PROTOCOL' as const

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export class McpAuthError extends McpError {
  readonly kind = 'AUTH' as const

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export class McpNotConnectedError extends McpError {
  readonly kind = 'NOT_CONNECTED' as const

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/**
 * Best-effort classifier for errors bubbling up from the SDK. We map well-known
 * SDK error shapes onto our typed hierarchy; anything we can't recognise becomes
 * a transport error so callers always get a typed `McpError`.
 */
export function classifyError(err: unknown): McpError {
  if (err instanceof McpError) return err

  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  // Auth: HTTP 401/403 surface through the SDK as plain Errors with the code in
  // the message. We also catch UnauthorizedError by name to avoid pulling in
  // SDK internals.
  if (
    (err instanceof Error && err.name === 'UnauthorizedError')
    || lower.includes('401')
    || lower.includes('unauthorized')
    || lower.includes('forbidden')
    || lower.includes('403')
  ) {
    return new McpAuthError(message, { cause: err })
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new McpTimeoutError(message, 0, { cause: err })
  }

  if (
    lower.includes('jsonrpc')
    || lower.includes('json-rpc')
    || lower.includes('invalid params')
    || lower.includes('method not found')
  ) {
    return new McpProtocolError(message, { cause: err })
  }

  return new McpTransportError(message, { cause: err })
}
