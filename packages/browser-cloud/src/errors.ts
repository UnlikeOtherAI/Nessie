/**
 * Typed failures for the cloud-browser transport.
 *
 * The split that matters is `CloudBrowserError` (a condition the caller can
 * explain to a person — no connection, quota, auth) versus
 * `CloudBrowserUnknownOutcomeError` (we do not know whether the remote side
 * acted). The second is the executor's ambiguity discipline: a click may have
 * placed an order and then lost its response, so it is never reported as a
 * plain failure and never silently retried.
 */

export const CLOUD_BROWSER_ERROR_CODES = {
  /** No connection resolves for this run at either scope. */
  NO_CONNECTION: 'CLOUD_BROWSER_NO_CONNECTION',
  /** The stored API key was rejected — the connection needs re-keying. */
  AUTH_FAILED: 'CLOUD_BROWSER_AUTH_FAILED',
  /** Browserbase could not be reached, or answered a 5xx. */
  UNREACHABLE: 'CLOUD_BROWSER_UNREACHABLE',
  /** Concurrency or session-creation rate exhausted (local cap or a 429). */
  CAPACITY: 'CLOUD_BROWSER_CAPACITY',
  /** The run has no open session, or it was already released. */
  NO_SESSION: 'CLOUD_BROWSER_NO_SESSION',
  /** A person holds the controls; the agent may not drive. */
  CONTROL_HELD: 'CLOUD_BROWSER_CONTROL_HELD',
  /** The session outlived its TTL. */
  EXPIRED: 'CLOUD_BROWSER_EXPIRED',
  /** The agent already has a live session for this run. */
  SESSION_ALREADY_OPEN: 'CLOUD_BROWSER_SESSION_ALREADY_OPEN',
  /** The remote endpoint is not a Browserbase origin. */
  UNTRUSTED_ENDPOINT: 'CLOUD_BROWSER_UNTRUSTED_ENDPOINT',
  /** A CDP command failed in a way the caller can describe. */
  COMMAND_FAILED: 'CLOUD_BROWSER_COMMAND_FAILED',
} as const

export type CloudBrowserErrorCode =
  (typeof CLOUD_BROWSER_ERROR_CODES)[keyof typeof CLOUD_BROWSER_ERROR_CODES]

export class CloudBrowserError extends Error {
  override readonly name = 'CloudBrowserError'

  constructor(
    readonly code: CloudBrowserErrorCode,
    message: string,
    /** Present when the failure came from an HTTP response. */
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * The remote side may or may not have acted. Never convert this into a
 * `success: false` tool result and never retry the action underneath it: a
 * browser action can be non-idempotent (an order placed, a message sent), so
 * the honest report is "unknown", exactly as the executor transport does with
 * `ExecutorUnknownOutcomeError`.
 */
export class CloudBrowserUnknownOutcomeError extends Error {
  override readonly name = 'CloudBrowserUnknownOutcomeError'

  constructor(message = 'The cloud browser action outcome is unknown.') {
    super(message)
  }
}

export const isCloudBrowserError = (error: unknown): error is CloudBrowserError =>
  error instanceof CloudBrowserError
  || (error instanceof Error && error.name === 'CloudBrowserError')
