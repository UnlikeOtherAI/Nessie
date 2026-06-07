import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { createApiClient, type ApiClient } from '@nessie/client-core'
import type { MeResponse } from '@nessie/schemas'

import { registerDeviceToken, unregisterDeviceToken } from './device-registration'
import {
  clearToken,
  DEFAULT_BASE_URL,
  loadBaseUrl,
  loadToken,
  saveBaseUrl,
  saveToken,
} from './secure-store'

// Shape of `POST /api/auth/session`, `GET /api/auth/dev-login` (the `data`
// envelope is unwrapped by the api client, so we receive `{ token, me }`).
type SessionResponse = {
  token: string
  me: MeResponse
}

type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

type AuthContextValue = {
  apiClient: ApiClient
  baseUrl: string
  me: MeResponse | null
  status: AuthStatus
  token: string | null
  devLogin: () => Promise<void>
  logout: () => Promise<void>
  passwordLogin: (input: { email: string; password: string }) => Promise<void>
  setBaseUrl: (next: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const useAuth = (): AuthContextValue => {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used within <AuthProvider>')
  }
  return value
}

export const AuthProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [baseUrl, setBaseUrlState] = useState(DEFAULT_BASE_URL)
  const [token, setToken] = useState<string | null>(null)
  const [me, setMe] = useState<MeResponse | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')

  // An unauthenticated client (token null) is used for login calls; once we
  // hold a token we recreate the client so requests carry the bearer header.
  const apiClient = useMemo(() => createApiClient({ baseUrl, token }), [baseUrl, token])

  const applySession = useCallback(
    async (session: SessionResponse) => {
      await saveToken(session.token)
      setToken(session.token)
      setMe(session.me)
      setStatus('signed-in')
      // Closing the push loop is best-effort and must never block sign-in.
      void registerDeviceToken({ baseUrl, token: session.token })
    },
    [baseUrl],
  )

  // On launch: restore the persisted base URL + token, then validate the token
  // against /api/auth/me. A stale/invalid token drops us back to the login UI.
  useEffect(() => {
    let cancelled = false
    const restore = async (): Promise<void> => {
      const storedBaseUrl = await loadBaseUrl()
      const storedToken = await loadToken()
      if (cancelled) {
        return
      }
      setBaseUrlState(storedBaseUrl)
      if (!storedToken) {
        setStatus('signed-out')
        return
      }
      try {
        const client = createApiClient({ baseUrl: storedBaseUrl, token: storedToken })
        const meResponse = await client.get<MeResponse>('/api/auth/me')
        if (cancelled) {
          return
        }
        setToken(storedToken)
        setMe(meResponse)
        setStatus('signed-in')
        void registerDeviceToken({ baseUrl: storedBaseUrl, token: storedToken })
      } catch {
        if (cancelled) {
          return
        }
        await clearToken()
        setStatus('signed-out')
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const passwordLogin = useCallback(
    async ({ email, password }: { email: string; password: string }) => {
      const client = createApiClient({ baseUrl, token: null })
      const session = await client.post<SessionResponse>('/api/auth/session', { email, password })
      await applySession(session)
    },
    [applySession, baseUrl],
  )

  const devLogin = useCallback(async () => {
    const client = createApiClient({ baseUrl, token: null })
    const session = await client.get<SessionResponse>('/api/auth/dev-login')
    await applySession(session)
  }, [applySession, baseUrl])

  const logout = useCallback(async () => {
    const currentToken = token
    try {
      if (currentToken) {
        await unregisterDeviceToken({ baseUrl, token: currentToken })
        await createApiClient({ baseUrl, token: currentToken }).delete('/api/auth/session')
      }
    } catch {
      // Logout is idempotent on the client side regardless of server result.
    }
    await clearToken()
    setToken(null)
    setMe(null)
    setStatus('signed-out')
  }, [baseUrl, token])

  const setBaseUrl = useCallback(async (next: string) => {
    const trimmed = next.trim()
    await saveBaseUrl(trimmed)
    setBaseUrlState(trimmed)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      apiClient,
      baseUrl,
      devLogin,
      logout,
      me,
      passwordLogin,
      setBaseUrl,
      status,
      token,
    }),
    [apiClient, baseUrl, devLogin, logout, me, passwordLogin, setBaseUrl, status, token],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
