import type { SessionPayload } from './auth-session.js'
import {
  ForeignSessionDetected,
  SessionMutationLoss,
  SessionSourcePreserved,
} from './session-mutation-errors.js'

export type AccessTokenRefreshCoordinator = () => Promise<string | null>

export type SessionReconcileCoordinator = () => Promise<SessionPayload | null>

/**
 * Three-way classification of a guarded mutation's decoded payload:
 *
 * - `target` — the payload is exactly the requested session. It is applied
 *   and the recovery resolves successfully.
 * - `source` — the payload is the preserved source session (same local user,
 *   local org/project/team, and UOA provider as the captured source). It is
 *   applied so the rotated access token survives, but the recovery REJECTS
 *   with {@link SessionSourcePreserved}: the caller must not navigate or
 *   report a switch. Nothing is cleared, revoked, or fenced.
 * - `foreign` — the payload is a different user or team. It is never
 *   applied: the coordinator revokes its cookie family via the caller-owned
 *   `onForeignSession`, clears exactly once, and permanently fences itself;
 *   the recovery rejects with {@link ForeignSessionDetected}.
 */
export type SessionMutationOutcome =
  | { kind: 'target' }
  | { kind: 'source'; message: string }
  | { kind: 'foreign'; message: string }

/**
 * Caller-supplied classification of a guarded mutation's returned payload —
 * run before `beforeApply`/`applySession` for the direct response and for the
 * one refresh winner after an opaque {@link SessionMutationLoss}.
 */
export type SessionMutationGuard = (
  payload: SessionPayload,
) => SessionMutationOutcome

export type SessionMutationCoordinator = {
  refresh: AccessTokenRefreshCoordinator
  reconcile: SessionReconcileCoordinator
  run: (mutation: () => Promise<SessionPayload>) => Promise<SessionPayload>
  runGuarded: (
    mutation: () => Promise<SessionPayload>,
    guard: SessionMutationGuard,
  ) => Promise<SessionPayload>
  terminate: (
    finalize: (latestPayload: SessionPayload | null) => Promise<void> | void,
  ) => Promise<void>
}

const terminatedError = (): Error => new Error('The session is being terminated.')

const ambientBlockedError = (): Error =>
  new Error('The ambient refresh is blocked behind a terminal fence or logout.')

const fencedError = (): Error => new Error('The session was fenced over a foreign session.')

/**
 * Serialize every mutation of the renewable session — startup restoration,
 * proactive renewal, API 401 recovery, and team switching — in FIFO
 * order. A rotating refresh cookie is single-use, so a refresh joins any
 * in-flight mutation and explicit mutations queue after it; every queued
 * mutation executes in turn. A null payload is an authentication rejection;
 * thrown errors deliberately leave the current session untouched.
 *
 * Terminal fencing is permanent and separate from logout: a foreign payload
 * (a guarded classification, or a foreign refresh winner after an opaque
 * loss) flips this coordinator terminal. The caller-owned `onForeignSession`
 * callback receives that exact payload — to revoke the current HTTP-only
 * cookie family — the local session is cleared exactly once, and no later
 * reconcile or refresh can ever adopt it. A `source` classification is the
 * middle state: applied, but the recovery rejects as a preserved non-switch.
 */
export const createSessionMutationCoordinator = (input: {
  applySession: (payload: SessionPayload) => void
  beforeApply?: (payload: SessionPayload) => Promise<void> | void
  /**
   * Optional fail-closed clear used instead of `clearSession`. It is invoked
   * synchronously when a terminal event begins; any returned work is awaited
   * only after remote revocation/finalization has started. Hosts must clear
   * bearer-visible local state before returning.
   */
  clearLocal?: () => Promise<void> | void
  clearSession: () => Promise<void> | void
  refresh: () => Promise<SessionPayload | null>
  // Caller-owned revocation of the cookie family behind a foreign session.
  // Awaited with a timeout-independent contract: revocation is reported and
  // local clearing still proceeds even if it throws.
  onForeignSession?: (payload: SessionPayload) => Promise<void> | void
  // One-time notification fired AFTER the terminal clear completes — whether
  // the terminal event is a foreign-session fence or logout (terminate). An
  // ordinary refresh that returns null clears but is not terminal and never
  // fires it. Hosts use it to retire this coordinator (e.g. bump a React
  // generation) so a later explicit login/recovery builds a fresh one; this
  // coordinator itself stays permanently fenced/terminated regardless.
  onTerminal?: () => void
  /**
   * Synchronous one-time hook fired at the exact moment a terminal event
   * BEGINS — the first line of `terminate` and the first line of a foreign
   * fence — strictly before any awaited work (revocation, finalization,
   * clearing). `onTerminal` alone is too late for the cross-remount fence:
   * while a logout DELETE or foreign revocation is still pending, a page,
   * Tauri window, or mobile WebView can reload and remount before the
   * completion notification exists, and the remount's startup restore would
   * consume the still-live cookie. Hosts persist their ambient-refresh
   * marker here; `onTerminal` remains only for post-clear coordinator
   * retirement.
   */
  onTerminalStart?: () => void
  /**
   * Synchronous ambient gate, read at call time by the public
   * `refresh`/`reconcile` facades (never by explicit `run`/`runGuarded`).
   * The host sets it from `onTerminalStart` and clears it only after a
   * successfully applied explicit login/bootstrap/dev login or a valid
   * explicit recovery, so a coordinator recreated after a terminal
   * notification cannot let automatic startup restoration consume an
   * ambient refresh cookie whose logout may have failed or been swallowed.
   * A run joined before the gate is set is never blocked mid-flight.
   */
  isAmbientRefreshBlocked?: () => boolean
}): SessionMutationCoordinator => {
  // FIFO tail of every queued mutation; resolved tails detach so the chain
  // never grows unbounded.
  let queue: Promise<void> | null = null
  // The newest settled-or-pending mutation — refresh/reconcile join it rather
  // than issuing a second request against the single-use cookie.
  let latest: Promise<SessionPayload | null> | null = null
  let latestToken: Promise<string | null> | null = null
  // Termination (logout) and terminal fencing (foreign session) are both
  // permanent: once either begins, no current or later async mutation may
  // apply a session. A second terminate() returns the same completion.
  let terminating = false
  let fenced = false
  let fenceCompletion: Promise<void> | null = null
  let termination: Promise<void> | null = null
  let terminalPayload: SessionPayload | null = null
  // Consecutive clears collapse into one: an in-flight guarded loss that
  // cleared on a foreign winner must not be cleared again by terminate.
  let cleared = false
  let clearCompletion: Promise<void> | null = null
  // The terminal notification fires at most once even when a foreign fence
  // and terminate overlap; whichever finishes its clear first owns it.
  let terminalNotified = false
  // The terminal-START hook likewise fires at most once, from whichever of
  // terminate/fenceForeign begins first.
  let terminalStartNotified = false

  const notifyTerminalStartOnce = (): void => {
    if (terminalStartNotified) return
    terminalStartNotified = true
    try {
      input.onTerminalStart?.()
    } catch {
      // The durable marker is defense in depth. A denied storage API must not
      // abort local clearing or the exact-session remote revocation.
    }
  }

  const notifyTerminalOnce = (): void => {
    if (terminalNotified) return
    terminalNotified = true
    try {
      input.onTerminal?.()
    } catch {
      // Terminal completion remains complete even if host notification fails.
    }
  }

  const clearOnce = (): Promise<void> => {
    if (cleared) return clearCompletion ?? Promise.resolve()
    cleared = true
    try {
      clearCompletion = Promise.resolve(
        input.clearLocal ? input.clearLocal() : input.clearSession(),
      ).catch(() => undefined)
    } catch {
      clearCompletion = Promise.resolve()
    }
    return clearCompletion
  }

  const resetClearAfterApply = (): void => {
    if (terminating || fenced) return
    cleared = false
    clearCompletion = null
  }

  // Permanently fence this coordinator over a foreign payload: hand it to the
  // caller-owned revocation callback, clear exactly once, and ensure no later
  // reconcile/refresh can ever adopt it. Idempotent per foreign payload.
  const fenceForeign = (payload: SessionPayload): Promise<void> => {
    if (fenceCompletion) return fenceCompletion
    fenced = true
    // Fence the ambient gate AND fail closed locally before awaiting the
    // caller-owned revocation: a remount during that await must already find
    // the marker persisted, and a held revocation must leave no
    // bearer-authenticated traffic possible.
    notifyTerminalStartOnce()
    const terminalClear = clearOnce()
    fenceCompletion = (async () => {
      try {
        await input.onForeignSession?.(payload)
      } finally {
        // A fence that resolves after logout began must not notify: the
        // termination finalizer revokes the winning family and owns the
        // single terminal notification itself. But the fence's foreign
        // payload is still the winning session — record it for that
        // finalizer rather than losing it (an in-flight mutation may already
        // have set one).
        if (terminating) {
          terminalPayload ??= payload
          return
        }
        await terminalClear
        notifyTerminalOnce()
      }
    })()
    return fenceCompletion
  }

  // Classify one decoded payload and resolve the runGuarded state machine:
  // target applies and resolves; source applies but rejects with a typed
  // preservation error; foreign fences and rejects with a typed detection
  // error. Runs inside the queued execute, before the global apply hooks.
  const resolveGuarded = async (
    payload: SessionPayload,
    guard: SessionMutationGuard,
  ): Promise<SessionPayload> => {
    // Termination outranks classification: a payload decoded after logout
    // began is handed to the terminal finalizer as the winning session —
    // never foreign-revoked, never applied.
    if (terminating) {
      terminalPayload = payload
      throw terminatedError()
    }
    const outcome = guard(payload)
    if (outcome.kind === 'target') {
      return payload
    }
    if (outcome.kind === 'source') {
      // Apply the refreshed source session so the rotated token survives,
      // but reject the recovery: this is a preservation, never a switch.
      // Nothing is cleared, revoked, or fenced.
      await input.beforeApply?.(payload)
      if (fenced) throw fencedError()
      if (terminating) {
        terminalPayload = payload
        throw terminatedError()
      }
      input.applySession(payload)
      resetClearAfterApply()
      throw new SessionSourcePreserved(outcome.message)
    }
    // Foreign: never adopt a session that is neither the target nor the
    // source, and never leave the old bearer beside the rotated cookie
    // either. Terminally fence so no later reconcile/refresh can apply it.
    await fenceForeign(payload)
    throw new ForeignSessionDetected(outcome.message)
  }

  const enqueue = (
    mutation: () => Promise<SessionPayload | null>,
  ): Promise<SessionPayload | null> => {
    if (terminating) return Promise.reject(terminatedError())
    if (fenced) return Promise.reject(fencedError())
    const execute = async (): Promise<SessionPayload | null> => {
      // Fences hold at every point a late mutation could commit: never apply
      // a session after logout or a foreign-session fence has begun.
      if (terminating) throw terminatedError()
      if (fenced) throw fencedError()
      const payload = await mutation()
      if (fenced) throw fencedError()
      if (terminating) {
        // The response arrived after logout started; hand the winning session
        // to the logout finalizer so the server can revoke that exact family.
        terminalPayload = payload
        throw terminatedError()
      }
      if (payload === null) {
        await clearOnce()
        return null
      }
      await input.beforeApply?.(payload)
      if (fenced) throw fencedError()
      if (terminating) {
        terminalPayload = payload
        throw terminatedError()
      }
      input.applySession(payload)
      resetClearAfterApply()
      return payload
    }
    // Chain onto the tail; a settled predecessor still lets its successor run.
    const run = queue ? queue.then(execute, execute) : execute()
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    queue = tail
    latest = run
    latestToken = run.then(
      (payload) => payload?.token ?? null,
      (error: unknown) => {
        throw error
      },
    )
    // Payload-aware callers may own `run` directly. Attach a rejection handler
    // to the token projection as well so that unused compatibility projections
    // never become unhandled rejections.
    void latestToken.catch(() => undefined)

    // Detach once settled — but only when nothing newer has been chained, so
    // an earlier completion never drops a later run or detaches a newer tail.
    const clearLatest = (): void => {
      if (queue === tail) queue = null
      if (latest === run) {
        latest = null
        latestToken = null
      }
    }
    void run.then(clearLatest, clearLatest)
    return run
  }

  // The ambient gate reads at CALL time: a caller that captured this facade
  // before a terminal fence/logout began (a startup restore scheduled in a
  // previous render, an in-flight 401 retry) must still be refused the
  // moment the gate is set.
  const reconcile = (): Promise<SessionPayload | null> => {
    if (input.isAmbientRefreshBlocked?.() === true) {
      return Promise.reject(ambientBlockedError())
    }
    if (terminating) return Promise.reject(terminatedError())
    if (fenced) return Promise.reject(fencedError())
    // A refresh arriving while another session mutation is queued must join
    // that mutation. Issuing a second request could otherwise apply an older
    // access token after a team switch or race two single-use cookies.
    if (latest) return latest
    return enqueue(input.refresh)
  }

  const refresh = (): Promise<string | null> => {
    if (input.isAmbientRefreshBlocked?.() === true) {
      return Promise.reject(ambientBlockedError())
    }
    if (terminating) return Promise.reject(terminatedError())
    if (fenced) return Promise.reject(fencedError())
    if (latestToken) return latestToken
    const pending = reconcile()
    return latestToken ?? pending.then((payload) => payload?.token ?? null)
  }

  const run = async (
    mutation: () => Promise<SessionPayload>,
  ): Promise<SessionPayload> => {
    const payload = await enqueue(mutation)
    if (!payload) throw new Error('Session mutation returned no session.')
    return payload
  }

  const runGuarded = async (
    mutation: () => Promise<SessionPayload>,
    guard: SessionMutationGuard,
  ): Promise<SessionPayload> => {
    const payload = await enqueue(async () => {
      let direct: SessionPayload
      try {
        direct = await mutation()
      } catch (error: unknown) {
        if (error instanceof SessionMutationLoss) {
          // The mutation likely committed but its response was lost (opaque
          // transport/body failure): the refresh cookie may already have
          // rotated to the new family. Exactly one refresh winner decides —
          // and it must still pass the same three-way classification against
          // the thunk's own captured guard. A refresh that comes back null
          // leaves the state untouched: the cookie still belongs to the
          // unchanged session, so clearing here would log the person out over
          // a transient loss.
          const winner = await input.refresh()
          if (winner === null) {
            // A refresh 401 after an opaque loss is an explicit
            // authentication rejection, not a transient loss: the cookie
            // family is already gone, so stale local auth must not remain.
            // Clear exactly once (this is NOT terminal — no onTerminal —
            // and never a foreign revocation), then rethrow the original
            // SessionMutationLoss so the picker surfaces the real failure.
            if (terminating) throw terminatedError()
            await clearOnce()
            throw error
          }
          if (terminating) {
            // Logout began during the one refresh: hand the winner to the
            // terminal finalizer so logout deletes that exact family —
            // never foreign-revoke or clear it here.
            terminalPayload = winner
            throw terminatedError()
          }
          return resolveGuarded(winner, guard)
        }
        // Typed refusals and every other failure surface as-is: no blind
        // refresh against a server that already answered.
        throw error
      }
      return resolveGuarded(direct, guard)
    })
    if (!payload) throw new Error('Session mutation returned no session.')
    return payload
  }

  const terminate = (
    finalize: (latestPayload: SessionPayload | null) => Promise<void> | void,
  ): Promise<void> => {
    // Idempotent: every later call joins the one completion. The terminal
    // flags deliberately never reset — logout ends this coordinator's life.
    if (termination) return termination
    terminating = true
    // The begin lane is fully synchronous and strictly ordered:
    //  1. Capture the pending mutation chain NOW so its settled payload —
    //     the old bearer proof the caller's finalizer (push unregister,
    //     remote revoke, DELETE) still needs after local state is gone —
    //     is adopted below before the finalizer runs.
    //  2. Set the terminal-start marker: while the finalizer's DELETE is
    //     still pending, a reloaded/remounted page must already read the
    //     fence and refuse every ambient refresh.
    //  3. Fail closed locally: clear the token, user/me, query boundary, and
    //     authenticated API client state ONCE, before ANY await. A held
    //     finalizer must leave no bearer-authenticated traffic possible.
    // The post-terminal notification and coordinator retirement stay on the
    // completion lane — they must not fire while the finalizer is pending.
    const pendingLatest = latest
    notifyTerminalStartOnce()
    const terminalClear = clearOnce()
    const pendingQueue = queue
    // A foreign fence already in flight must finish its caller-owned
    // revocation before logout finalizes, so the terminal notification never
    // fires mid-fence and the finalizer can adopt the winning payload.
    const pendingFence = fenceCompletion
    const ending = (async (): Promise<void> => {
      try {
        await pendingQueue
        if (pendingLatest) {
          // Adopt the pending mutation's settled payload as the winning
          // session for the finalizer; an in-flight mutation that already
          // recorded one (or a settled fence's foreign payload) keeps it.
          try {
            terminalPayload ??= await pendingLatest
          } catch {
            terminalPayload ??= null
          }
        }
        if (pendingFence) {
          await pendingFence.catch(() => undefined)
        }
        await finalize(terminalPayload)
      } finally {
        await terminalClear
        terminalPayload = null
        notifyTerminalOnce()
      }
    })()
    termination = ending
    return ending
  }

  return { reconcile, refresh, run, runGuarded, terminate }
}

export const createAccessTokenRefreshCoordinator = (input: {
  applySession: (payload: SessionPayload) => void
  beforeApply?: (payload: SessionPayload) => Promise<void> | void
  clearLocal?: () => Promise<void> | void
  clearSession: () => Promise<void> | void
  refresh: () => Promise<SessionPayload | null>
  onForeignSession?: (payload: SessionPayload) => Promise<void> | void
}): AccessTokenRefreshCoordinator => createSessionMutationCoordinator(input).refresh
