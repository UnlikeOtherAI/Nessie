/**
 * The mutation request likely committed but its response was lost — a
 * network/transport failure or an unreadable body, never an HTTP status the
 * server actually sent. Guarded session mutations treat this as opaque: the
 * refresh cookie may already have rotated, so exactly one guarded refresh
 * decides which session to adopt.
 *
 * Shared by auth-session (which throws it) and the session-mutation
 * coordinator (which detects it) without a cyclic import. Detection is real
 * `instanceof` against this class — never `error.name`, which any ordinary
 * Error can forge.
 */
export class SessionMutationLoss extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SessionMutationLoss'
  }
}

/**
 * Non-success outcome of a guarded session mutation: the renewed session was
 * decoded but is not the exact requested target. This is a refusal, not a
 * crash — the picker's promise rejects with this error so it can surface a
 * notice and never navigate as if the switch succeeded.
 */
export abstract class SessionMutationRejection extends Error {}

/**
 * The renewed session IS the preserved source session (same local user,
 * local org/project/team, and UOA provider — it just never landed on the
 * requested target). It is applied so the rotated access token survives, but
 * the recovery rejects: the picker must not navigate or report a switch.
 * The old session is preserved exactly: never cleared, revoked, or fenced.
 */
export class SessionSourcePreserved extends SessionMutationRejection {
  constructor(message: string) {
    super(message)
    this.name = 'SessionSourcePreserved'
  }
}

/**
 * The renewed session belongs to a DIFFERENT user or a different local
 * team than the preserved source. The coordinator has already revoked
 * its cookie family, cleared once, and permanently fenced itself before this
 * error is thrown; the picker only needs to surface the failure.
 */
export class ForeignSessionDetected extends SessionMutationRejection {
  constructor(message: string) {
    super(message)
    this.name = 'ForeignSessionDetected'
  }
}
