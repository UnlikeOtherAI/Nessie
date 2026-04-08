import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import type { MeResponse } from '@nessie/schemas'
import {
  clearStoredToken,
  loadStoredToken,
  storeToken,
} from '../lib/storage'
import type {
  AuthProviderDescriptor,
  BootstrapModeResponse,
} from '../lib/api-client'

type SessionState = 'authenticated' | 'bootstrap' | 'loading' | 'unauthenticated'

type BootstrapInput = {
  bootstrapToken: string
  displayName: string
  email: string
  password: string
}

type LoginInput = {
  email: string
  password: string
} | {
  code: string
  codeVerifier: string
  providerId: string
  redirectUri: string
}

type AuthSessionContextValue = {
  bootstrap: (input: BootstrapInput) => Promise<void>
  bootstrapState: BootstrapModeResponse | null
  login: (input: LoginInput) => Promise<void>
  logout: () => Promise<void>
  me: MeResponse | null
  providers: AuthProviderDescriptor[]
  refreshSession: () => Promise<void>
  sessionState: SessionState
  token: string | null
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

const parseResponse = async <TData,>(response: Response): Promise<TData> => {
  const payload = (await response.json()) as { data: TData }
  return payload.data
}

const parseApiError = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        code?: string
        message?: string
      }
    }
    return payload.error?.message ?? JSON.stringify(payload)
  } catch {
    return await response.text()
  }
}

const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''

export const AuthSessionProvider = ({ children }: PropsWithChildren) => {
  const [sessionState, setSessionState] = useState<SessionState>('loading')
  const [token, setToken] = useState<string | null>(() => loadStoredToken())
  const [me, setMe] = useState<MeResponse | null>(null)
  const [bootstrapState, setBootstrapState] = useState<BootstrapModeResponse | null>(null)
  const [providers, setProviders] = useState<AuthProviderDescriptor[]>([])

  const refreshSession = async (): Promise<void> => {
    setSessionState('loading')

    const providerResponse = await fetch(`${baseUrl}/api/auth/providers`)
    if (providerResponse.ok) {
      setProviders(await parseResponse<AuthProviderDescriptor[]>(providerResponse))
    }

    const headers = token ? { authorization: `Bearer ${token}` } : undefined
    const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers })

    if (meResponse.status === 401) {
      if (token) {
        clearStoredToken()
      }

      setToken(null)
      setMe(null)
      setBootstrapState(null)
      setSessionState('unauthenticated')
      return
    }

    if (!meResponse.ok) {
      throw new Error(await meResponse.text())
    }

    const payload = await meResponse.json() as { data: BootstrapModeResponse | MeResponse }
    if ('bootstrapMode' in payload.data) {
      setBootstrapState(payload.data)
      setMe(null)
      setSessionState('bootstrap')
      return
    }

    setBootstrapState(null)
    setMe(payload.data)
    setSessionState('authenticated')
  }

  useEffect(() => {
    void refreshSession().catch(() => {
      setSessionState('unauthenticated')
      setMe(null)
      setBootstrapState(null)
      setToken(null)
      clearStoredToken()
    })
  }, [])

  const bootstrap = async (input: BootstrapInput): Promise<void> => {
    const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw new Error(await parseApiError(response))
    }

    const payload = await response.json() as { data: { me: MeResponse; token: string } }
    storeToken(payload.data.token)
    setToken(payload.data.token)
    setMe(payload.data.me)
    setBootstrapState(null)
    setSessionState('authenticated')
  }

  const login = async (input: LoginInput): Promise<void> => {
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw new Error(await parseApiError(response))
    }

    const payload = await response.json() as { data: { me: MeResponse; token: string } }
    storeToken(payload.data.token)
    setToken(payload.data.token)
    setMe(payload.data.me)
    setBootstrapState(null)
    setSessionState('authenticated')
  }

  const logout = async (): Promise<void> => {
    if (token) {
      await fetch(`${baseUrl}/api/auth/session`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
        },
      }).catch(() => undefined)
    }

    clearStoredToken()
    setToken(null)
    setMe(null)
    setSessionState('unauthenticated')
  }

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      bootstrap,
      bootstrapState,
      login,
      logout,
      me,
      providers,
      refreshSession,
      sessionState,
      token,
    }),
    [bootstrapState, me, providers, sessionState, token],
  )

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>
}

export const useAuthSession = (): AuthSessionContextValue => {
  const context = useContext(AuthSessionContext)
  if (!context) {
    throw new Error('useAuthSession must be used within AuthSessionProvider')
  }

  return context
}
