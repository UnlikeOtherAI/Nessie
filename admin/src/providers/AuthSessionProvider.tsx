import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import type { MeResponse } from '@nessie/schemas'
import {
  createAuthSessionApi,
  type AuthProviderDescriptor,
  type AuthSessionState,
  type BootstrapInput,
  type BootstrapModeResponse,
  type LoginInput,
} from '@nessie/client-core'
import {
  clearStoredToken,
  loadStoredToken,
  storeToken,
} from '../lib/storage'
import { getBaseUrl } from '../lib/api-client'

type AuthSessionContextValue = {
  applyMeResponse: (nextMe: MeResponse) => void
  bootstrap: (input: BootstrapInput) => Promise<void>
  bootstrapState: BootstrapModeResponse | null
  devLogin: () => Promise<void>
  login: (input: LoginInput) => Promise<void>
  logout: () => Promise<void>
  me: MeResponse | null
  providers: AuthProviderDescriptor[]
  refreshSession: () => Promise<void>
  sessionState: AuthSessionState
  token: string | null
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

// Admin (web) supplies the Vite-resolved base URL; @nessie/client-core stays
// env-agnostic. localStorage is the web TokenStore backing.
const authApi = createAuthSessionApi(getBaseUrl())

export const AuthSessionProvider = ({ children }: PropsWithChildren) => {
  const [sessionState, setSessionState] = useState<AuthSessionState>('loading')
  const [token, setToken] = useState<string | null>(() => loadStoredToken())
  const [me, setMe] = useState<MeResponse | null>(null)
  const [bootstrapState, setBootstrapState] = useState<BootstrapModeResponse | null>(null)
  const [providers, setProviders] = useState<AuthProviderDescriptor[]>([])

  const refreshSession = async (): Promise<void> => {
    setSessionState('loading')

    setProviders(await authApi.fetchProviders())

    const snapshot = await authApi.fetchSession(token)

    if (snapshot.kind === 'unauthenticated') {
      if (token) {
        clearStoredToken()
      }
      setToken(null)
      setMe(null)
      setBootstrapState(null)
      setSessionState('unauthenticated')
      return
    }

    if (snapshot.kind === 'bootstrap') {
      setBootstrapState(snapshot.bootstrap)
      setMe(null)
      setSessionState('bootstrap')
      return
    }

    setBootstrapState(null)
    setMe(snapshot.me)
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

  const applySession = (payload: { me: MeResponse; token: string }): void => {
    storeToken(payload.token)
    setToken(payload.token)
    setMe(payload.me)
    setBootstrapState(null)
    setSessionState('authenticated')
  }

  const applyMeResponse = (nextMe: MeResponse): void => {
    setMe(nextMe)
    setBootstrapState(null)
    setSessionState('authenticated')
  }

  const bootstrap = async (input: BootstrapInput): Promise<void> => {
    applySession(await authApi.bootstrap(input))
  }

  const devLogin = async (): Promise<void> => {
    applySession(await authApi.devLogin())
  }

  const login = async (input: LoginInput): Promise<void> => {
    applySession(await authApi.login(input))
  }

  const logout = async (): Promise<void> => {
    await authApi.logout(token)
    clearStoredToken()
    setToken(null)
    setMe(null)
    setSessionState('unauthenticated')
  }

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      applyMeResponse,
      bootstrap,
      bootstrapState,
      devLogin,
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
