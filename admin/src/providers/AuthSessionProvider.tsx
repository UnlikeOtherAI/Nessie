import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { MeResponse } from '@nessie/schemas'
import {
  createAuthSessionApi,
  type AuthProviderDescriptor,
  type AuthSessionState,
  type BootstrapInput,
  type BootstrapModeResponse,
  type LoginInput,
  type SwitchContextInput,
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
  refreshAccessToken: () => Promise<string | null>
  refreshSession: () => Promise<void>
  sessionState: AuthSessionState
  switchContext: (input: SwitchContextInput) => Promise<void>
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
  const pendingRefresh = useRef<Promise<string | null> | null>(null)

  const applySession = useCallback((payload: { me: MeResponse; token: string }): void => {
    storeToken(payload.token)
    setToken(payload.token)
    setMe(payload.me)
    setBootstrapState(null)
    setSessionState('authenticated')
  }, [])

  const clearSession = useCallback((): void => {
    clearStoredToken()
    setToken(null)
    setMe(null)
    setBootstrapState(null)
    setSessionState('unauthenticated')
  }, [])

  // Single-flight access-token renewal from the refresh cookie. Concurrent 401s
  // share one in-flight request so the refresh token rotates exactly once.
  const refreshAccessToken = useCallback((): Promise<string | null> => {
    if (pendingRefresh.current) {
      return pendingRefresh.current
    }
    const run = (async (): Promise<string | null> => {
      try {
        const payload = await authApi.refresh()
        if (payload) {
          applySession(payload)
          return payload.token
        }
      } catch {
        // fall through to the signed-out state below
      }
      clearSession()
      return null
    })()
    pendingRefresh.current = run
    void run.finally(() => {
      pendingRefresh.current = null
    })
    return run
  }, [applySession, clearSession])

  const refreshSession = async (): Promise<void> => {
    setSessionState('loading')

    setProviders(await authApi.fetchProviders())

    const snapshot = await authApi.fetchSession(token)

    if (snapshot.kind === 'unauthenticated') {
      // The access token may simply have expired — try the refresh cookie before
      // giving up, so a returning user with a live refresh token stays signed in.
      const renewed = await authApi.refresh()
      if (renewed) {
        applySession(renewed)
        return
      }
      clearSession()
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

  const switchContext = async (input: SwitchContextInput): Promise<void> => {
    applySession(await authApi.switchContext(token, input))
  }

  const logout = async (): Promise<void> => {
    await authApi.logout(token)
    clearSession()
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
      refreshAccessToken,
      refreshSession,
      sessionState,
      switchContext,
      token,
    }),
    [bootstrapState, me, providers, refreshAccessToken, sessionState, token],
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
