import { SyncCursorExpiredError } from '@nessie/comms-connect'

/** A fixed-endpoint Microsoft OAuth or Graph failure, safe to persist or log. */
export class MicrosoftApiError extends Error {
  readonly status: number

  readonly retryable: boolean

  readonly code?: string

  readonly needsReauthorization: boolean

  /** Consent, policy or administrator denial — retrying cannot fix it. */
  readonly authorizationBlocked: boolean

  constructor(input: {
    operation: string
    status: number
    retryable: boolean
    code?: string
    needsReauthorization?: boolean
    authorizationBlocked?: boolean
  }) {
    super(
      `[comms-microsoft] ${input.operation} failed with status ${input.status}`
        + (input.code ? ` (${input.code})` : ''),
    )
    this.name = 'MicrosoftApiError'
    this.status = input.status
    this.retryable = input.retryable
    this.code = input.code
    this.needsReauthorization = input.needsReauthorization ?? false
    this.authorizationBlocked = input.authorizationBlocked ?? false
  }
}

/** The refresh grant is dead; the stored connection must be authorized again. */
export class MicrosoftReauthorizationRequiredError extends Error {
  readonly needsReauthorization = true

  constructor(reason?: string) {
    super(
      '[comms-microsoft] credential can no longer be refreshed; '
        + `reauthorization required${reason ? ` (${reason})` : ''}`,
    )
    this.name = 'MicrosoftReauthorizationRequiredError'
  }
}

/** A Graph delta token can no longer be resumed and needs a bounded resync. */
export class MicrosoftDeltaCursorExpiredError extends SyncCursorExpiredError {
  constructor() {
    super('[comms-microsoft] Graph delta cursor expired; a bounded resync is required')
    this.name = 'MicrosoftDeltaCursorExpiredError'
  }
}
