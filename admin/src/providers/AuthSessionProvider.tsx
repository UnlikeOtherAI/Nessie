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
  createSessionMutationCoordinator,
  getAccessTokenRenewalDelayMs,
  type AuthSessionState,
  type BootstrapInput,
  type BootstrapModeResponse,
  type LoginInput,
  type SwitchContextInput,
  type SwitchUoaWorkspaceInput,
} from '@nessie/client-core'
import { useQueryClient } from '@tanstack/react-query'
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
  switchUoaWorkspace: (input: SwitchUoaWorkspaceInput) => Promise<void>
  token: string | null
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

const RETRY_DELAYS_MS = [1_000, 2_500, 5_000, 10_000, 30_000] as const
const retryDelay = (attempt: number): number =>
  RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000
const ACCESS_TOKEN_RENEWAL_LEEWAY_MS = 120_000
const ACCESS_TOKEN_RENEWAL_RETRY_MS = 30_000
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647

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
  const queryClient = useQueryClient()
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
    tokenRef.current = payload.token
    setToken(payload.token)
    setMe(payload.me)
    setBootstrapState(null)
    setSessionState('authenticated')
  }, [])

  const clearSession = useCallback((): void => {
    clearStoredToken()
    tokenRef.current = null
    setToken(null)
    setMe(null)
    setBootstrapState(null)
    setSessionState('unauthenticated')
  }, [])

  // Startup restore, every API 401, and workspace switching share this exact
  // coordinator. Both refresh cookies are single-use, so no other path may
  // mutate the session concurrently or apply an older response afterwards.
  const sessionMutations = useMemo(
    () =>
      createSessionMutationCoordinator({
        applySession,
        clearSession,
        refresh: authApi.refresh,
      }),
    [applySession, clearSession],
  )
  const refreshAccessToken = sessionMutations.refresh

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

  // Do not wait for a visible request to fail after the short-lived JWT expires.
  // The refresh credential stays in its httpOnly cookie; this timer only asks
  // the shared single-flight coordinator to rotate it before expiry. Returning
  // from a backgrounded desktop/mobile webview also renews immediately when the
  // scheduled time elapsed while the app was suspended.
  useEffect(() => {
    if (!token) return

    let cancelled = false
    let renewalTimer: ReturnType<typeof setTimeout> | null = null

    const clearRenewalTimer = (): void => {
      if (renewalTimer) {
        clearTimeout(renewalTimer)
        renewalTimer = null
      }
    }

    const scheduleRenewal = (delayMs: number): void => {
      clearRenewalTimer()
      renewalTimer = setTimeout(() => {
        const remainingDelay = getAccessTokenRenewalDelayMs(
          token,
          Date.now(),
          ACCESS_TOKEN_RENEWAL_LEEWAY_MS,
        )
        if (remainingDelay === null) return
        if (remainingDelay > 0) {
          scheduleRenewal(remainingDelay)
          return
        }
        void renewAccessToken()
      }, Math.min(delayMs, MAX_TIMEOUT_DELAY_MS))
    }

    const renewAccessToken = async (): Promise<void> => {
      if (cancelled) return
      try {
        await refreshAccessToken()
      } catch {
        // A temporary outage must not turn into a logout. Keep retrying this
        // exact token until a rotation succeeds or the server explicitly says
        // the refresh family is no longer valid.
        if (!cancelled) {
          scheduleRenewal(ACCESS_TOKEN_RENEWAL_RETRY_MS)
        }
      }
    }

    const renewWhenDue = (): void => {
      if (document.visibilityState !== 'visible') return
      const delay = getAccessTokenRenewalDelayMs(
        token,
        Date.now(),
        ACCESS_TOKEN_RENEWAL_LEEWAY_MS,
      )
      if (delay === 0) {
        clearRenewalTimer()
        void renewAccessToken()
      }
    }

    const delay = getAccessTokenRenewalDelayMs(
      token,
      Date.now(),
      ACCESS_TOKEN_RENEWAL_LEEWAY_MS,
    )
    if (delay !== null) {
      scheduleRenewal(delay)
    }
    window.addEventListener('focus', renewWhenDue)
    document.addEventListener('visibilitychange', renewWhenDue)

    return () => {
      cancelled = true
      clearRenewalTimer()
      window.removeEventListener('focus', renewWhenDue)
      document.removeEventListener('visibilitychange', renewWhenDue)
    }
  }, [refreshAccessToken, token])

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
    await sessionMutations.run(
      () => authApi.switchContext(tokenRef.current, input),
      async () => {
        await queryClient.cancelQueries()
        queryClient.clear()
      },
    )
  }

  const switchUoaWorkspace = async (input: SwitchUoaWorkspaceInput): Promise<void> => {
    await sessionMutations.run(
      () => authApi.switchUoaWorkspace(tokenRef.current, input),
      async () => {
        await queryClient.cancelQueries()
        queryClient.clear()
      },
    )
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
      switchUoaWorkspace,
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

/** For read-only facades that can also render inside isolated component tests. */
export const useOptionalAuthSession = (): AuthSessionContextValue | null =>
  useContext(AuthSessionContext)
