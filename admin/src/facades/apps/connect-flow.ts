/**
 * The universal Connect flow, as data.
 *
 * Everything here is pure: no React, no `window`, no fetch. The hook
 * (`facades/apps/connect-hooks.ts`) supplies the outside world and the panel
 * (`ConnectProgress.tsx`) renders whatever this file says the state is, so the
 * awkward parts — a popup that closes without answering, a message that never
 * arrives, a provider that takes two minutes — are decided in a file a test can
 * drive end to end rather than inside an effect.
 *
 * Vocabulary is the store's, not the connector model's: an app, an account, a
 * sign-in. The words MCP, OAuth, PKCE and transport never reach a person. The
 * codes and the sentences they print live beside this in `connect-error-copy.ts`.
 */

import type { ConnectErrorCode } from './connect-error-copy'

// ─── The server's answer ────────────────────────────────────────────────────

/**
 * `POST /api/apps/:slug/connect`'s discriminated union.
 *
 * Declared here rather than imported because the client has to *check* it: the
 * API client returns `payload.data` unvalidated, and a body this code did not
 * understand must fail as a connection error, never be read as a success. When
 * `@nessie/schemas` exports the response schema this type becomes an import and
 * the parser below defers to it — the shape is the server's to state.
 */
export type AppConnectResponse =
  | { status: 'connected'; connectionId: string }
  | { status: 'authorize'; connectionId: string; authorizationUrl: string }
  | { status: 'needs_secret'; connectionId: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** An http(s) URL, and nothing else, is what we are willing to open for a person. */
const readHttpUrl = (source: Record<string, unknown>, key: string): string | null => {
  const raw = readString(source, key)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : null
  } catch {
    return null
  }
}

export const parseAppConnectResponse = (value: unknown): AppConnectResponse | null => {
  if (!isRecord(value)) return null
  const connectionId = readString(value, 'connectionId')
  if (!connectionId) return null

  switch (value.status) {
    case 'connected':
      return { connectionId, status: 'connected' }
    case 'needs_secret':
      return { connectionId, status: 'needs_secret' }
    case 'authorize': {
      const authorizationUrl = readHttpUrl(value, 'authorizationUrl')
      return authorizationUrl
        ? { authorizationUrl, connectionId, status: 'authorize' }
        : null
    }
    default:
      return null
  }
}

// ─── The completion message ─────────────────────────────────────────────────

/**
 * What the callback page posts back to its opener.
 *
 * The callback is a constant HTML page that interpolates nothing from the
 * request, so this payload is fixed and can be checked exactly. The origin is
 * checked separately by the caller — a message that passes this shape check
 * from an origin we did not open is still an attacker's message.
 */
export type ConnectCompletionMessage = { ok: boolean }

export const parseConnectCompletionMessage = (
  data: unknown,
): ConnectCompletionMessage | null => {
  if (!isRecord(data)) return null
  if (data.source !== 'nessie' || data.kind !== 'mcp-oauth') return null
  return typeof data.ok === 'boolean' ? { ok: data.ok } : null
}

/**
 * The one origin a completion message may come from.
 *
 * The callback is served by the API, which in production is a different origin
 * from the admin. An unset `VITE_API_BASE_URL` means same-origin, so the page's
 * own origin stands in; a base URL we cannot parse yields the page origin too,
 * because the alternative — accepting every origin — is the bug this exists to
 * prevent.
 */
export const resolveApiOrigin = (baseUrl: string, pageOrigin: string): string => {
  const trimmed = baseUrl.trim()
  if (!trimmed) return pageOrigin
  try {
    return new URL(trimmed, pageOrigin).origin
  } catch {
    return pageOrigin
  }
}

// ─── Timing ─────────────────────────────────────────────────────────────────

/** After this long in the waiting state the panel admits the provider is slow. */
export const CONNECT_STILL_WAITING_MS = 20_000
/** After this long we stop claiming to be waiting and say the sign-in expired. */
export const CONNECT_AUTHORIZATION_TIMEOUT_MS = 120_000

// ─── State ──────────────────────────────────────────────────────────────────

export type ConnectPhase =
  | 'idle'
  | 'probing'
  | 'awaiting_authorization'
  | 'verifying'
  | 'connected'
  | 'needs_secret'
  | 'error'

/**
 * Why we are verifying, which is what decides the sentence when verification
 * never resolves: a person who closed the window cancelled, while a callback
 * that reported success and then produced no connection is a failure.
 */
export type ConnectVerifyReason = 'closed' | 'reported'

export type ConnectState = {
  /** Present once the popup was opened, so "open it again" can reuse it. */
  authorizationUrl: string | null
  /** The account this flow is about, from the server's first answer. */
  connectionId: string | null
  error: { code: ConnectErrorCode; detail: string | null } | null
  phase: ConnectPhase
  /** `window.open` returned null; the same URL is offered as a plain link. */
  popupBlocked: boolean
  /** Whether this app needed a provider sign-in, so the step list shows it. */
  requiresAuthorization: boolean
  verifyReason: ConnectVerifyReason | null
  /** Time spent waiting for the provider; drives the 20 s line and the stop. */
  waitedMs: number
}

export const initialConnectState: ConnectState = {
  authorizationUrl: null,
  connectionId: null,
  error: null,
  phase: 'idle',
  popupBlocked: false,
  requiresAuthorization: false,
  verifyReason: null,
  waitedMs: 0,
}

export type ConnectEvent =
  /** The person pressed Connect. */
  | { type: 'start' }
  /** The connect endpoint answered. */
  | { type: 'server_result'; result: AppConnectResponse }
  /** `window.open` either produced a window or was blocked. */
  | { type: 'launcher_result'; opened: boolean }
  /** A threshold in the waiting state was reached. */
  | { type: 'waited'; elapsedMs: number }
  /** The callback page posted its fixed message. */
  | { type: 'authorization_reported'; ok: boolean }
  /** The sign-in window went away without reporting anything. */
  | { type: 'authorization_closed' }
  /** A status read observed the account. */
  | { type: 'connection_observed'; connected: boolean }
  /** Status reads ran out while verifying. */
  | { type: 'verification_exhausted' }
  /** Anything that threw. */
  | { type: 'failed'; code: ConnectErrorCode; detail: string | null }
  /** Dismiss, or resume a flow this page left behind. */
  | { type: 'reset' }
  | { type: 'resume'; authorizationUrl: string | null; connectionId: string; waitedMs: number }

const failed = (
  state: ConnectState,
  code: ConnectErrorCode,
  detail: string | null = null,
): ConnectState => ({ ...state, error: { code, detail }, phase: 'error', verifyReason: null })

const enterVerifying = (
  state: ConnectState,
  verifyReason: ConnectVerifyReason,
): ConnectState => ({ ...state, phase: 'verifying', verifyReason })

export const connectReducer = (state: ConnectState, event: ConnectEvent): ConnectState => {
  switch (event.type) {
    case 'start':
      return { ...initialConnectState, phase: 'probing' }

    case 'server_result': {
      const { result } = event
      if (result.status === 'connected') {
        return { ...state, connectionId: result.connectionId, phase: 'connected' }
      }
      if (result.status === 'needs_secret') {
        return { ...state, connectionId: result.connectionId, phase: 'needs_secret' }
      }
      return {
        ...state,
        authorizationUrl: result.authorizationUrl,
        connectionId: result.connectionId,
        phase: 'awaiting_authorization',
        requiresAuthorization: true,
        waitedMs: 0,
      }
    }

    case 'launcher_result':
      // Only meaningful while we are waiting for a sign-in; a late answer from
      // a launcher must not paint a blocked-popup warning over a finished flow.
      if (state.phase !== 'awaiting_authorization') return state
      return { ...state, popupBlocked: !event.opened }

    case 'waited':
      if (state.phase !== 'awaiting_authorization') return state
      if (event.elapsedMs >= CONNECT_AUTHORIZATION_TIMEOUT_MS) {
        return failed({ ...state, waitedMs: event.elapsedMs }, 'AUTH_EXPIRED')
      }
      return { ...state, waitedMs: event.elapsedMs }

    case 'authorization_reported':
      if (state.phase !== 'awaiting_authorization') return state
      // The callback completed the exchange server-side. Success still has to
      // be confirmed by reading the account, because the message says only that
      // the callback ran.
      return event.ok ? enterVerifying(state, 'reported') : failed(state, 'AUTH_FAILED')

    case 'authorization_closed':
      // A closed window is not yet a cancellation: the exchange may have
      // completed a moment before the person closed it, or the message may have
      // been dropped. Verify first, decide after.
      if (state.phase !== 'awaiting_authorization') return state
      return enterVerifying(state, 'closed')

    case 'connection_observed':
      if (state.phase !== 'awaiting_authorization' && state.phase !== 'verifying') return state
      return event.connected ? { ...state, error: null, phase: 'connected' } : state

    case 'verification_exhausted':
      if (state.phase !== 'verifying') return state
      return state.verifyReason === 'closed'
        ? failed(state, 'AUTH_CANCELLED')
        : failed(state, 'CONNECTION_FAILED')

    case 'failed':
      return failed(state, event.code, event.detail)

    case 'resume':
      // A flow this page walked away from and came back to. It re-enters the
      // waiting state rather than idle, so returning from the provider does not
      // look like nothing ever happened.
      return {
        ...initialConnectState,
        authorizationUrl: event.authorizationUrl,
        connectionId: event.connectionId,
        phase: 'awaiting_authorization',
        requiresAuthorization: true,
        waitedMs: event.waitedMs,
      }

    case 'reset':
      return initialConnectState
  }
}

// ─── The step list ──────────────────────────────────────────────────────────

export type ConnectStepId = 'check' | 'authorize' | 'capabilities'
export type ConnectStepStatus = 'active' | 'done' | 'pending'
export type ConnectStep = { id: ConnectStepId; label: string; status: ConnectStepStatus }

/**
 * What the panel lists, never a bare spinner.
 *
 * The sign-in step appears only for an app that asked for one, so a no-auth
 * server does not show a step it will never perform.
 */
export const connectSteps = (state: ConnectState, providerName: string): ConnectStep[] => {
  if (state.phase === 'idle' || state.phase === 'error' || state.phase === 'needs_secret') {
    return []
  }

  const steps: ConnectStep[] = [
    {
      id: 'check',
      label: 'Checking the server…',
      status: state.phase === 'probing' ? 'active' : 'done',
    },
  ]

  if (state.requiresAuthorization) {
    steps.push({
      id: 'authorize',
      label: `Signing in to ${providerName}…`,
      status:
        state.phase === 'awaiting_authorization'
          ? 'active'
          : state.phase === 'probing'
            ? 'pending'
            : 'done',
    })
  }

  steps.push({
    id: 'capabilities',
    label: 'Loading what it can do…',
    status:
      state.phase === 'connected' ? 'done' : state.phase === 'verifying' ? 'active' : 'pending',
  })

  return steps
}

/** After 20 s the panel stops pretending the wait is normal. */
export const connectShowsSlowProviderNote = (state: ConnectState): boolean =>
  state.phase === 'awaiting_authorization' && state.waitedMs >= CONNECT_STILL_WAITING_MS

// ─── The pending marker ─────────────────────────────────────────────────────

/**
 * A sign-in that left the page.
 *
 * On a phone the authorization opens the system browser and this tab may be
 * discarded; on the desktop a person can navigate away mid-flow. The marker is
 * what makes the page say "waiting for GitHub" on return instead of looking
 * idle. It is per-tab (`sessionStorage`) and holds no secret — an account id
 * and a timestamp, both of which the page already has.
 */
export type ConnectPendingMarker = {
  authorizationUrl: string | null
  connectionId: string
  startedAt: number
}

export const connectMarkerKey = (slug: string): string => `nessie.apps.connect.${slug}`

export const serializeConnectMarker = (marker: ConnectPendingMarker): string =>
  JSON.stringify(marker)

/**
 * Reads a marker back, discarding one older than a sign-in could still be live.
 * A stale marker would put the page into a waiting state nothing will ever
 * resolve.
 */
export const parseConnectMarker = (
  raw: string | null,
  now: number,
): ConnectPendingMarker | null => {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const connectionId = readString(parsed, 'connectionId')
  const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : null
  if (!connectionId || startedAt === null) return null

  const elapsed = now - startedAt
  if (elapsed < 0 || elapsed >= CONNECT_AUTHORIZATION_TIMEOUT_MS) return null

  return {
    authorizationUrl: readHttpUrl(parsed, 'authorizationUrl'),
    connectionId,
    startedAt,
  }
}
