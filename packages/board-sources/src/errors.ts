/**
 * The failures a provider adapter may report, each classified so the sync
 * engine can decide between "retry later", "a person must act", and
 * "the vendor said no" without a provider branch.
 */

/** The vendor refused a write. Surfaced synchronously to whoever asked for it. */
export class SourceRejectedError extends Error {
  readonly code: string
  readonly detail: string

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'SourceRejectedError'
    this.code = code
    this.detail = detail
  }
}

/**
 * A credential a person just pasted is not usable, and the reason is theirs to
 * act on: the wrong kind of token, a missing scope, a typo. Distinct from
 * `SourceAuthError`, which is a working credential that has since stopped being
 * accepted — that one's remedy is "reconnect", this one's is "fix what you
 * typed", and the connect form says which field.
 */
export class SourceCredentialRejectedError extends Error {
  readonly code: string
  readonly detail: string

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'SourceCredentialRejectedError'
    this.code = code
    this.detail = detail
  }
}

/** The credential is no longer accepted. A person must reconnect. */
export class SourceAuthError extends Error {
  constructor(message = 'The provider rejected this connection’s credential') {
    super(message)
    this.name = 'SourceAuthError'
  }
}

/** A transient budget refusal. Backs off; changes no health state. */
export class SourceRateLimitedError extends Error {
  readonly retryAfterMs: number | null

  constructor(retryAfterMs: number | null = null) {
    super('The provider is rate limiting this connection')
    this.name = 'SourceRateLimitedError'
    this.retryAfterMs = retryAfterMs
  }
}

/** The stored cursor is no longer valid; the engine falls back to a bounded re-sync. */
export class SourceCursorExpiredError extends Error {
  constructor(message = 'The stored sync cursor is no longer valid') {
    super(message)
    this.name = 'SourceCursorExpiredError'
  }
}

/** The container is gone upstream, or the credential can no longer see it. */
export class SourceContainerGoneError extends Error {
  constructor(message = 'The container is no longer reachable') {
    super(message)
    this.name = 'SourceContainerGoneError'
  }
}

/**
 * Thrown when a sync or webhook path asks for a provider no adapter is
 * registered for. Typed so the worker distinguishes "not configured on this
 * deployment" — park the job with a clear reason — from a runtime fault.
 */
export class AdapterNotRegisteredError extends Error {
  readonly provider: string

  constructor(provider: string) {
    super(`No board-source adapter registered for provider "${provider}"`)
    this.name = 'AdapterNotRegisteredError'
    this.provider = provider
  }
}
