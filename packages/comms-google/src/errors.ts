/**
 * Typed error surface for the Gmail connector. Every failure the connector can
 * raise is one of these, so the worker (and tests) can distinguish a transient
 * rate-limit from a fatal request, an expired history cursor that needs a
 * bounded resync, and a credential that can no longer be refreshed.
 *
 * No token material is ever placed in a message or property here.
 */

/** A Gmail/OAuth HTTP failure, tagged retryable vs fatal. */
export class GmailApiError extends Error {
  readonly status: number

  readonly retryable: boolean

  readonly reason?: string

  constructor(params: {
    status: number
    retryable: boolean
    operation: string
    reason?: string
  }) {
    super(
      `[comms-google] ${params.operation} failed with status ${params.status}`
        + (params.reason ? ` (${params.reason})` : ''),
    )
    this.name = 'GmailApiError'
    this.status = params.status
    this.retryable = params.retryable
    this.reason = params.reason
  }
}

/**
 * The stored Gmail `historyId` is older than the mailbox's retained history
 * window, so `users.history.list` returned 404. The worker must run a bounded
 * resync (re-seed the baseline `historyId` and back-fill the recent window)
 * rather than silently dropping the missed messages.
 */
export class GmailHistoryExpiredError extends Error {
  readonly emailAddress: string

  readonly staleHistoryId: string

  constructor(emailAddress: string, staleHistoryId: string) {
    super(
      '[comms-google] stored historyId is expired; a bounded resync is required',
    )
    this.name = 'GmailHistoryExpiredError'
    this.emailAddress = emailAddress
    this.staleHistoryId = staleHistoryId
  }
}

/**
 * The refresh grant was rejected (`invalid_grant`): the user revoked access or
 * the refresh token is no longer valid. The connection must move to
 * `needs_reauthorization`; retrying will not help.
 */
export class GmailReauthorizationRequiredError extends Error {
  constructor(reason?: string) {
    super(
      '[comms-google] credential can no longer be refreshed; reauthorization required'
        + (reason ? ` (${reason})` : ''),
    )
    this.name = 'GmailReauthorizationRequiredError'
  }
}
