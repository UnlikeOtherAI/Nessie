import type { MeResponse } from '@nessie/schemas'
import type { AuthProviderDescriptor, BootstrapModeResponse } from './api-types.js'
export {
  ForeignSessionDetected,
  SessionMutationLoss,
  SessionMutationRejection,
  SessionSourcePreserved,
} from './session-mutation-errors.js'
import { SessionMutationLoss } from './session-mutation-errors.js'
import type { SessionMutationOutcome } from './session-mutation-coordinator.js'

export {
  createAccessTokenRefreshCoordinator,
  createSessionMutationCoordinator,
  type AccessTokenRefreshCoordinator,
  type SessionMutationCoordinator,
  type SessionMutationGuard,
  type SessionMutationOutcome,
  type SessionReconcileCoordinator,
} from './session-mutation-coordinator.js'

export type AuthSessionState = 'authenticated' | 'bootstrap' | 'loading' | 'unauthenticated'

export type BootstrapInput = {
  bootstrapToken: string
  displayName: string
  email: string
  password: string
}

// An external identity-provider code exchange (PKCE) for session creation.
export type ExternalLoginInput = {
  code: string
  codeVerifier: string
  providerId: string
  redirectUri: string
  theme?: string
}

export type LoginInput =
  | {
      email: string
      password: string
    }
  | ExternalLoginInput

// Exact external (UOA) workspace a session must be scoped to.
export type ExpectedWorkspaceTarget = {
  organizationId: string
  teamId: string
}

// An authenticated workspace-switch reauthorization: the external-auth code
// exchange plus the exact external workspace the renewed session must land
// on. The API rejects the exchange before any local mutation or Set-Cookie
// when the provider's active org/team differ.
export type RecoverWorkspaceSessionInput = {
  code: string
  codeVerifier: string
  expectedWorkspace: ExpectedWorkspaceTarget
  // Workspace recovery is UOA-only: the expectedWorkspace discriminant is
  // defined against the identity provider's own active selection.
  providerId: 'uoa'
  redirectUri: string
  theme?: string
}

// Persists the bearer token across reloads. On web this is backed by
// `localStorage`; on React Native the host injects an equivalent.
export type TokenStore = {
  clear: () => void
  load: () => string | null
  store: (token: string) => void
}

export type SessionPayload = {
  me: MeResponse
  token: string
}

/**
 * True when an exchanged session is scoped to exactly the expected external
 * workspace. The session claims the active UOA org/team through
 * `me.uoaWorkspaces` (the identity provider's own active selection).
 */
export const sessionMatchesExpectedWorkspace = (
  payload: SessionPayload,
  expected: ExpectedWorkspaceTarget,
): boolean => {
  // Exactly one active UOA workspace may exist; an ambiguous multiple-active
  // response is rejected outright rather than pattern-matched.
  const active = (payload.me.uoaWorkspaces ?? []).filter((workspace) => workspace.active)
  if (active.length !== 1) return false
  const [workspace] = active
  return workspace?.organizationId === expected.organizationId
    && workspace?.teamId === expected.teamId
}

/**
 * The preserved source session a workspace recovery starts from, captured by
 * the caller immediately inside the queued mutation thunk — never at enqueue
 * time, so it is the session that is current when the request is actually
 * sent. A decoded payload that misses the exact target is only the *source*
 * (applied but a rejected non-switch) when every one of these fields matches;
 * anything else is foreign.
 */
export type WorkspaceSessionSource = {
  userId: string
  organizationId: string
  projectId: string
  teamId: string
  providerId: 'uoa'
}

/**
 * Capture the source session a guarded workspace recovery must preserve. Only
 * a UOA-authenticated session can recover onto a UOA workspace; any other
 * provider yields null and the recovery must refuse before it sends.
 */
export const captureWorkspaceSessionSource = (
  me: MeResponse,
): WorkspaceSessionSource | null => {
  if (me.auth.providerId !== 'uoa') return null
  return {
    userId: me.user.id,
    organizationId: me.context.organizationId,
    projectId: me.context.projectId,
    teamId: me.context.teamId,
    providerId: 'uoa',
  }
}

/**
 * Three-way classification of a workspace-recovery payload against the exact
 * requested external target and the captured source session. `target` when
 * the payload is the SAME person and provider as the captured source (same
 * local user id, UOA provider) AND its active UOA org/team are exactly the
 * requested pair; `source` when the payload is the preserved source session
 * (same local user id, local org/project/team, and UOA provider); `foreign`
 * otherwise. A payload that claims the exact requested UOA workspace but
 * belongs to a different user or a different provider is foreign, never the
 * target.
 */
export const classifyWorkspaceSessionPayload = (
  payload: SessionPayload,
  expectedWorkspace: ExpectedWorkspaceTarget,
  source: WorkspaceSessionSource,
): SessionMutationOutcome => {
  const me = payload.me
  if (
    sessionMatchesExpectedWorkspace(payload, expectedWorkspace)
    && me.user.id === source.userId
    && me.auth.providerId === source.providerId
  ) {
    return { kind: 'target' }
  }
  if (
    me.user.id === source.userId
    && me.context.organizationId === source.organizationId
    && me.context.projectId === source.projectId
    && me.context.teamId === source.teamId
    && me.auth.providerId === source.providerId
  ) {
    return {
      kind: 'source',
      message: 'The session was renewed on the current workspace, but the switch did not complete. Try switching again.',
    }
  }
  return {
    kind: 'foreign',
    message: 'The renewed session did not land on the requested workspace. Try switching again.',
  }
}

const MAX_SAFE_JWT_EXPIRY_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000)

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const payload = token.split('.')[1]
  if (!payload) return null

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padding = '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(`${base64}${padding}`)
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0)
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    return decoded !== null && typeof decoded === 'object'
      ? decoded as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * Read an access token's expiry solely to schedule a renewal. Authentication
 * still happens on the server when the token is used or refreshed.
 */
export const getAccessTokenExpiresAtMs = (token: string): number | null => {
  const exp = decodeJwtPayload(token)?.exp
  if (
    typeof exp !== 'number'
    || !Number.isSafeInteger(exp)
    || exp <= 0
    || exp > MAX_SAFE_JWT_EXPIRY_SECONDS
  ) {
    return null
  }

  return exp * 1_000
}

/**
 * Return the delay before an access token should be renewed. `null` means the
 * token cannot be scheduled and normal startup/401 recovery remains in charge.
 */
export const getAccessTokenRenewalDelayMs = (
  token: string,
  nowMs = Date.now(),
  renewalLeewayMs = 120_000,
): number | null => {
  const expiresAtMs = getAccessTokenExpiresAtMs(token)
  if (expiresAtMs === null) return null

  return Math.max(0, expiresAtMs - nowMs - Math.max(0, renewalLeewayMs))
}

// Re-scope the session to another workspace the user already belongs to. The
// server re-validates membership of the full org/project/team triple.
export type SwitchContextInput = {
  organizationId: string
  projectId: string
  teamId: string
}

export type SwitchUoaWorkspaceInput = {
  organizationId: string
  teamId: string
}

export class AuthSessionApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'AuthSessionApiError'
  }
}

// Result of fetching the current session: either an authenticated user, the
// bootstrap flow, or unauthenticated.
export type SessionSnapshot =
  | { kind: 'authenticated'; me: MeResponse }
  | { kind: 'bootstrap'; bootstrap: BootstrapModeResponse }
  | { kind: 'unauthenticated' }

export type AuthSessionApi = {
  bootstrap: (input: BootstrapInput) => Promise<SessionPayload>
  devLogin: () => Promise<SessionPayload>
  fetchProviders: () => Promise<AuthProviderDescriptor[]>
  fetchSession: (token: string | null) => Promise<SessionSnapshot>
  login: (input: LoginInput) => Promise<SessionPayload>
  logout: (token: string | null) => Promise<void>
  // Reauthorize an already-authenticated session onto an exact external
  // workspace. `token` is read at call time and sent as the current Bearer
  // proof beside the PKCE exchange. An HTTP refusal is typed
  // (AuthSessionApiError); a transport failure or unreadable body is opaque
  // (SessionMutationLoss) so the guarded coordinator can decide whether one
  // refresh winner is warranted.
  recoverWorkspaceSession: (
    token: string,
    input: RecoverWorkspaceSessionInput,
  ) => Promise<SessionPayload>
  // Renew the access token from the httpOnly refresh cookie. Returns the new
  // session, or null when there is no valid refresh cookie.
  refresh: () => Promise<SessionPayload | null>
  // Switch the active workspace (org/project/team); returns the re-scoped session.
  switchContext: (token: string | null, input: SwitchContextInput) => Promise<SessionPayload>
  // Switch a renewable UOA session without leaving Nessie.
  switchUoaWorkspace: (
    token: string | null,
    input: SwitchUoaWorkspaceInput,
  ) => Promise<SessionPayload>
}

const normaliseBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/$/, '')

const parseResponse = async <TData>(response: Response): Promise<TData> => {
  const payload = (await response.json()) as { data: TData }
  return payload.data
}

const parseApiError = async (response: Response): Promise<AuthSessionApiError> => {
  const text = await response.text()
  if (!text) {
    return new AuthSessionApiError(
      `${response.status} ${response.statusText}`,
      undefined,
      response.status,
    )
  }
  try {
    const payload = JSON.parse(text) as { error?: { code?: string; message?: string } }
    return new AuthSessionApiError(
      payload.error?.message ?? text,
      payload.error?.code,
      response.status,
    )
  } catch {
    return new AuthSessionApiError(text, undefined, response.status)
  }
}

export const createAuthSessionApi = (baseUrl: string): AuthSessionApi => {
  const resolvedBaseUrl = normaliseBaseUrl(baseUrl)

  const fetchProviders = async (): Promise<AuthProviderDescriptor[]> => {
    const response = await fetch(`${resolvedBaseUrl}/api/auth/providers`, {
      credentials: 'include',
    })
    if (!response.ok) {
      throw await parseApiError(response)
    }
    return parseResponse<AuthProviderDescriptor[]>(response)
  }

  const fetchSession = async (token: string | null): Promise<SessionSnapshot> => {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined
    const response = await fetch(`${resolvedBaseUrl}/api/auth/me`, {
      headers,
      credentials: 'include',
    })

    if (response.status === 401) {
      return { kind: 'unauthenticated' }
    }

    if (!response.ok) {
      throw new Error(await response.text())
    }

    const payload = (await response.json()) as { data: BootstrapModeResponse | MeResponse }
    if ('bootstrapMode' in payload.data) {
      return { kind: 'bootstrap', bootstrap: payload.data }
    }

    return { kind: 'authenticated', me: payload.data }
  }

  // Bearer-free session creation (login/bootstrap). The response may already
  // have Set-Cookie'd the renewed family even when the body never arrives, so
  // opaque failures — transport errors, unreadable bodies — surface as
  // SessionMutationLoss; the guarded coordinator then lets one refresh winner
  // decide. A delivered HTTP status is a typed AuthSessionApiError and never
  // triggers that refresh.
  const postSession = async (
    path: string,
    body: unknown,
    token?: string | null,
  ): Promise<SessionPayload> => {
    let response: Response
    try {
      response = await fetch(`${resolvedBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        // Required so the browser stores the httpOnly refresh cookie returned
        // by a cross-origin login.
        credentials: 'include',
      })
    } catch (error: unknown) {
      throw new SessionMutationLoss('The session response was lost in transit.', error)
    }

    if (!response.ok) {
      throw await parseApiError(response)
    }

    try {
      return await parseResponse<SessionPayload>(response)
    } catch (error: unknown) {
      throw new SessionMutationLoss('The session response body could not be read.', error)
    }
  }

  return {
    bootstrap: (input) => postSession('/api/auth/bootstrap', input),
    devLogin: async () => {
      const response = await fetch(`${resolvedBaseUrl}/api/auth/dev-login`, {
        credentials: 'include',
      })
      if (!response.ok) {
        throw await parseApiError(response)
      }
      return parseResponse<SessionPayload>(response)
    },
    fetchProviders,
    fetchSession,
    // Ordinary login stays bearer-free: the caller has no session to prove.
    login: (input) => postSession('/api/auth/session', input),
    logout: async (token) => {
      await fetch(`${resolvedBaseUrl}/api/auth/session`, {
        method: 'DELETE',
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        // Send the refresh cookie so the server can revoke the token family.
        credentials: 'include',
      }).catch(() => undefined)
    },
    // Workspace-switch reauthorization goes to the same session route but is
    // a distinct, authenticated operation: the expectedWorkspace discriminant
    // is valid only beside the current Bearer proof, and the exchange is
    // fenced by the guarded coordinator's exact-target check.
    recoverWorkspaceSession: async (token, input) => {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Workspace session recovery requires an authenticated bearer token.')
      }
      return postSession('/api/auth/session', input, token)
    },
    refresh: async () => {
      const response = await fetch(`${resolvedBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      })
      if (response.status === 401) {
        return null
      }
      if (!response.ok) {
        throw await parseApiError(response)
      }
      return parseResponse<SessionPayload>(response)
    },
    switchContext: async (token, input) => {
      const response = await fetch(`${resolvedBaseUrl}/api/auth/switch-context`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
        // Rotate the refresh cookie to the newly scoped session.
        credentials: 'include',
      })
      if (!response.ok) {
        throw await parseApiError(response)
      }
      return parseResponse<SessionPayload>(response)
    },
    switchUoaWorkspace: async (token, input) => {
      const response = await fetch(`${resolvedBaseUrl}/api/auth/uoa/workspace`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
        credentials: 'include',
      })
      if (!response.ok) {
        throw await parseApiError(response)
      }
      return parseResponse<SessionPayload>(response)
    },
  }
}
