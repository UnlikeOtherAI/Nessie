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
  createAccessTokenRefreshCoordinator,
  createAuthSessionApi,
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
import {
  NATIVE_PUSH_UNREGISTER_EVENT,
} from '../lib/native-push-registration'
import { isReactNativeWebView } from '../lib/mobile-shell'

type AuthSessionContextValue = {
  applyMeResponse: (nextMe: MeResponse) => void
  bootstrap: (input: BootstrapInput) => Promise<void>
  bootstrapState: BootstrapModeResponse | null
  devLogin: () => Promise<void>
  login: (input: LoginInput) => Promise<void>
  logout: () => Promise<void>
  me: MeResponse | null
  refreshAccessToken: () => Promise<string | null>
  refreshSession: () => Promise<void>
  sessionState: AuthSessionState
  switchContext: (input: SwitchContextInput) => Promise<void>
  token: string | null
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

const RETRY_DELAYS_MS = [1_000, 2_500, 5_000, 10_000, 30_000] as const
const retryDelay = (attempt: number): number =>
  RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000

const unregisterNativePushDevice = (): Promise<void> =>
  new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent(NATIVE_PUSH_UNREGISTER_EVENT, { detail: { complete: resolve } }),
    )
  })

// Admin (web) supplies the Vite-resolved base URL; @nessie/client-core stays
// env-agnostic. localStorage is the web TokenStore backing.
const authApi = createAuthSessionApi(getBaseUrl())

export const AuthSessionProvider = ({ children }: PropsWithChildren) => {
  const [sessionState, setSessionState] = useState<AuthSessionState>('loading')
  const [token, setToken] = useState<string | null>(() => loadStoredToken())
  // Session restoration is one lifecycle, not a side effect of token changes:
  // keep its callback stable while still reading the latest login/logout token.
  const tokenRef = useRef(token)
  tokenRef.current = token
  const [me, setMe] = useState<MeResponse | null>(null)
  const [bootstrapState, setBootstrapState] = useState<BootstrapModeResponse | null>(null)

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

  // Startup restore and every API 401 share this exact coordinator. A refresh
  // cookie is single-use, so no other path may call authApi.refresh directly.
  // Only an explicit refresh 401 clears credentials; transient errors reject,
  // leaving the stored token intact for the retry effects below.
  const refreshAccessToken = useMemo(
    () =>
      createAccessTokenRefreshCoordinator({
        applySession,
        clearSession,
        refresh: authApi.refresh,
      }),
    [applySession, clearSession],
  )

  const refreshSession = useCallback(async (): Promise<void> => {
    setSessionState((current) => current === 'authenticated' ? current : 'loading')
    const snapshot = await authApi.fetchSession(tokenRef.current)

    if (snapshot.kind === 'unauthenticated') {
      // The access token may simply have expired — try the refresh cookie before
      // giving up, so a returning user with a live refresh token stays signed in.
      await refreshAccessToken()
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
  }, [refreshAccessToken])

  // A network outage, rate limit, or server error during restore is not a
  // logout. Keep the bearer token in localStorage and retry until the API is
  // reachable. An explicit refresh 401 resolves normally after clearSession,
  // so it does not enter this retry loop.
  useEffect(() => {
    let cancelled = false
    let restoring = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const restoreSession = async (): Promise<void> => {
      if (cancelled || restoring) return
      restoring = true
      try {
        await refreshSession()
        attempt = 0
      } catch {
        if (cancelled) return
        const delay = retryDelay(attempt)
        attempt += 1
        retryTimer = setTimeout(() => void restoreSession(), delay)
      } finally {
        restoring = false
      }
    }

    const retryWhenOnline = (): void => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      void restoreSession()
    }

    window.addEventListener('online', retryWhenOnline)
    void restoreSession()
    return () => {
      cancelled = true
      window.removeEventListener('online', retryWhenOnline)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [refreshSession])

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
    if (isReactNativeWebView()) {
      await unregisterNativePushDevice()
    }
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
      refreshAccessToken,
      refreshSession,
      sessionState,
      switchContext,
      token,
    }),
    [bootstrapState, me, refreshAccessToken, refreshSession, sessionState, token],
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
