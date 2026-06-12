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
}

const normaliseBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/$/, '')

const parseResponse = async <TData>(response: Response): Promise<TData> => {
  const payload = (await response.json()) as { data: TData }
  return payload.data
}

const parseApiError = async (response: Response): Promise<string> => {
  const text = await response.text()
  if (!text) {
    return `${response.status} ${response.statusText}`
  }
  try {
    const payload = JSON.parse(text) as { error?: { code?: string; message?: string } }
    return payload.error?.message ?? text
  } catch {
    return text
  }
}

export const createAuthSessionApi = (baseUrl: string): AuthSessionApi => {
  const resolvedBaseUrl = normaliseBaseUrl(baseUrl)

  const fetchProviders = async (): Promise<AuthProviderDescriptor[]> => {
    const response = await fetch(`${resolvedBaseUrl}/api/auth/providers`)
    if (!response.ok) {
      return []
    }
    return parseResponse<AuthProviderDescriptor[]>(response)
  }

  const fetchSession = async (token: string | null): Promise<SessionSnapshot> => {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined
    const response = await fetch(`${resolvedBaseUrl}/api/auth/me`, { headers })

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
    })

    if (!response.ok) {
      throw new Error(await parseApiError(response))
    }

    return parseResponse<SessionPayload>(response)
  }

  return {
    bootstrap: (input) => postSession('/api/auth/bootstrap', input),
    devLogin: async () => {
      const response = await fetch(`${resolvedBaseUrl}/api/auth/dev-login`)
      if (!response.ok) {
        throw new Error(await parseApiError(response))
      }
      return parseResponse<SessionPayload>(response)
    },
    fetchProviders,
    fetchSession,
    login: (input) => postSession('/api/auth/session', input),
    logout: async (token) => {
      if (!token) {
        return
      }
      await fetch(`${resolvedBaseUrl}/api/auth/session`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    },
  }
}
