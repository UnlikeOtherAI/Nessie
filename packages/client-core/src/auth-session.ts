import type { MeResponse } from '@nessie/schemas'
import type { AuthProviderDescriptor, BootstrapModeResponse } from './api-types.js'

export type AuthSessionState = 'authenticated' | 'bootstrap' | 'loading' | 'unauthenticated'

export type BootstrapInput = {
  bootstrapToken: string
  displayName: string
  email: string
  password: string
}

export type LoginInput =
  | {
      email: string
      password: string
    }
  | {
      code: string
      codeVerifier: string
      providerId: string
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

export type AccessTokenRefreshCoordinator = () => Promise<string | null>

export type SessionReconcileCoordinator = () => Promise<SessionPayload | null>

export type SessionMutationCoordinator = {
  refresh: AccessTokenRefreshCoordinator
  reconcile: SessionReconcileCoordinator
  run: (mutation: () => Promise<SessionPayload>) => Promise<SessionPayload>
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

/**
 * Serialize every mutation of the renewable session — startup restoration,
 * proactive renewal, API 401 recovery, and workspace switching. A rotating
 * refresh cookie is single-use, so a refresh joins any in-flight mutation and
 * explicit mutations wait their turn. A null payload is an authentication
 * rejection; thrown errors deliberately leave the current session untouched.
 */
export const createSessionMutationCoordinator = (input: {
  applySession: (payload: SessionPayload) => void
  beforeApply?: (payload: SessionPayload) => Promise<void> | void
  clearSession: () => Promise<void> | void
  refresh: () => Promise<SessionPayload | null>
}): SessionMutationCoordinator => {
  let queue: Promise<void> | null = null
  let latest: Promise<SessionPayload | null> | null = null
  let latestToken: Promise<string | null> | null = null

  const enqueue = (
    mutation: () => Promise<SessionPayload | null>,
  ): Promise<SessionPayload | null> => {
    const execute = async (): Promise<SessionPayload | null> => {
      const payload = await mutation()
      if (payload === null) {
        await input.clearSession()
        return null
      }
      await input.beforeApply?.(payload)
      input.applySession(payload)
      return payload
    }
    const run = queue ? queue.then(execute) : execute()
    const nextQueue = run.then(() => undefined, () => undefined)
    queue = nextQueue
    latest = run
    latestToken = run.then(
      (payload) => payload?.token ?? null,
      (error: unknown) => { throw error },
    )
    // Payload-aware callers may own `run` directly. Attach a rejection handler
    // to the token projection as well so that unused compatibility projections
    // never become unhandled rejections.
    void latestToken.catch(() => undefined)

    const clearLatest = (): void => {
      if (queue === nextQueue) queue = null
      if (latest === run) {
        latest = null
        latestToken = null
      }
    }
    void run.then(clearLatest, clearLatest)
    return run
  }

  const reconcile = (): Promise<SessionPayload | null> => {
    // A refresh arriving while another session mutation is queued must join
    // that mutation. Issuing a second request could otherwise apply an older
    // access token after a workspace switch or race two single-use cookies.
    if (latest) return latest
    return enqueue(input.refresh)
  }

  const refresh = (): Promise<string | null> => {
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

  return { reconcile, refresh, run }
}

export const createAccessTokenRefreshCoordinator = (input: {
  applySession: (payload: SessionPayload) => void
  beforeApply?: (payload: SessionPayload) => Promise<void> | void
  clearSession: () => Promise<void> | void
  refresh: () => Promise<SessionPayload | null>
}): AccessTokenRefreshCoordinator => createSessionMutationCoordinator(input).refresh

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

  const postSession = async (path: string, body: unknown): Promise<SessionPayload> => {
    const response = await fetch(`${resolvedBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Required so the browser stores the httpOnly refresh cookie returned by
      // a cross-origin login.
      credentials: 'include',
    })

    if (!response.ok) {
      throw await parseApiError(response)
    }

    return parseResponse<SessionPayload>(response)
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
    login: (input) => postSession('/api/auth/session', input),
    logout: async (token) => {
      await fetch(`${resolvedBaseUrl}/api/auth/session`, {
        method: 'DELETE',
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        // Send the refresh cookie so the server can revoke the token family.
        credentials: 'include',
      }).catch(() => undefined)
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
