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
  captureWorkspaceSessionSource,
  classifyWorkspaceSessionPayload,
  createAuthSessionApi,
  createSessionMutationCoordinator,
  type AuthSessionState,
  type BootstrapInput,
  type BootstrapModeResponse,
  type ExpectedWorkspaceTarget,
  type ExternalLoginInput,
  type LoginInput,
  type RecoverWorkspaceSessionInput,
  type SessionPayload,
  type SwitchContextInput,
  type SwitchUoaWorkspaceInput,
} from '@nessie/client-core'
import { useQueryClient } from '@tanstack/react-query'
import {
  clearStoredToken,
  loadStoredToken,
  loadStoredTokenMode,
  storeToken,
  type StoredTokenMode,
} from '../lib/storage'
import { getBaseUrl } from '../lib/api-client'
import {
  clearSessionIfCurrent,
  createImportedSessionApplyTracker,
  finalizeSessionLogout,
  IMPORTED_SESSION_SCOPE_MESSAGE,
  isSessionCredentialCurrent,
  resolveSessionRefreshAction,
  resolveTerminatingSessionCredential,
  type SessionCredentialSnapshot,
} from '../lib/imported-session-policy'
import { resolveImportedSession } from '../lib/session-debug-import'
import {
  NATIVE_PUSH_UNREGISTER_EVENT,
} from '../lib/native-push-registration'
import { isReactNativeWebView } from '../lib/mobile-shell'
import {
  createSessionQueryBoundary,
  isCurrentSessionResponse,
} from './auth-session-query-reset'
import { useAccessTokenRenewal } from './useAccessTokenRenewal'

type AuthSessionContextValue = {
  applyMeResponse: (nextMe: MeResponse) => void
  bootstrap: (input: BootstrapInput) => Promise<void>
  bootstrapState: BootstrapModeResponse | null
  devLogin: () => Promise<void>
  importAccessToken: (accessToken: string) => Promise<void>
  login: (input: LoginInput) => Promise<void>
  logout: () => Promise<void>
  me: MeResponse | null
  reconcileSession: () => Promise<SessionPayload | null>
  /**
   * Complete an external-auth code exchange for a workspace-switch
   * reauthorization. Unlike `login` this never applies the exchanged session
   * until the payload proves it is scoped to exactly `expectedWorkspace`; a
   * mismatch leaves the current session, token, and query cache untouched.
   * Returns the applied payload.
   */
  recoveryExchange: (
    input: ExternalLoginInput,
    expectedWorkspace: ExpectedWorkspaceTarget,
  ) => Promise<SessionPayload>
  refreshAccessToken: (expected?: SessionCredentialSnapshot) => Promise<string | null>
  refreshSession: () => Promise<void>
  sessionMode: StoredTokenMode
  sessionState: AuthSessionState
  switchContext: (input: SwitchContextInput) => Promise<void>
  switchUoaWorkspace: (input: SwitchUoaWorkspaceInput) => Promise<void>
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
  const queryClient = useQueryClient()
  const [sessionState, setSessionState] = useState<AuthSessionState>('loading')
  const [token, setToken] = useState<string | null>(() => loadStoredToken())
  // Session restoration is one lifecycle, not a side effect of token changes:
  // keep its callback stable while still reading the latest login/logout token.
  const tokenRef = useRef(token)
  tokenRef.current = token
  const importedSessionTokenRef = useRef<string | null>(
    token && loadStoredTokenMode() === 'imported' ? token : null,
  )
  const importedMutationsInFlightRef = useRef(0)
  const importedApplyTracker = useMemo(() => createImportedSessionApplyTracker(), [])
  const sessionMode: StoredTokenMode = token && importedSessionTokenRef.current === token
    ? 'imported'
    : 'renewable'
  const [me, setMe] = useState<MeResponse | null>(null)
  const meRef = useRef(me)
  meRef.current = me
  const [bootstrapState, setBootstrapState] = useState<BootstrapModeResponse | null>(null)

  const resetTenantQueries = useCallback(async (): Promise<void> => {
    await queryClient.cancelQueries().catch(() => undefined)
    queryClient.clear()
  }, [queryClient])

  const sessionQueryBoundary = useMemo(
    () => createSessionQueryBoundary({
      readCurrentMe: () => meRef.current,
      resetTenantQueries,
    }),
    [resetTenantQueries],
  )

  const applySession = useCallback((payload: { me: MeResponse; token: string }): void => {
    const imported = importedApplyTracker.has(payload.token)
    storeToken(payload.token, imported ? 'imported' : 'renewable')
    tokenRef.current = payload.token
    importedSessionTokenRef.current = imported ? payload.token : null
    meRef.current = payload.me
    setToken(payload.token)
    setMe(payload.me)
    setBootstrapState(null)
    setSessionState('authenticated')
  }, [importedApplyTracker])

  const commitSessionClear = useCallback((): void => {
    clearStoredToken()
    tokenRef.current = null
    importedSessionTokenRef.current = null
    meRef.current = null
    setToken(null)
    setMe(null)
    setBootstrapState(null)
    setSessionState('unauthenticated')
  }, [])

  const clearSession = useCallback(async (): Promise<void> => {
    await sessionQueryBoundary.clear()
    commitSessionClear()
  }, [commitSessionClear, sessionQueryBoundary])

  const clearImportedSession = useCallback(async (expectedToken: string): Promise<void> => {
    await clearSessionIfCurrent({
      clearQueries: sessionQueryBoundary.clear,
      commit: commitSessionClear,
      expectedToken,
      readCurrentToken: () => tokenRef.current,
    })
  }, [commitSessionClear, sessionQueryBoundary])

  // A foreign-session fence or logout permanently terminates its coordinator.
  // That coordinator stays fenced forever, but the PROVIDER is not dead: once
  // the terminal clear completes, the generation bumps so a later explicit
  // login or workspace recovery — after React re-renders — runs against a
  // fresh coordinator. An ordinary refresh that returns null is not terminal
  // and never bumps it.
  const [coordinatorGeneration, setCoordinatorGeneration] = useState(0)
  // Login, startup restore, every API 401, and workspace switching share this
  // exact coordinator. Both refresh cookies are single-use, so no other path
  // may mutate the session concurrently or apply an older response afterwards.
  const sessionMutations = useMemo(
    () =>
      createSessionMutationCoordinator({
        applySession,
        beforeApply: sessionQueryBoundary.beforeApply,
        clearSession,
        // A foreign session that missed its guarded target must never live on
        // beside the rotated HTTP-only cookie family: revoke that exact family
        // using the foreign payload's own bearer as the proof.
        onForeignSession: async (payload) => {
          await authApi.logout(payload.token)
        },
        onTerminal: () => {
          setCoordinatorGeneration((generation) => generation + 1)
        },
        refresh: authApi.refresh,
      }),
    // coordinatorGeneration is not read inside the factory; it only re-runs
    // the memo after the previous coordinator went terminal.
    [applySession, clearSession, coordinatorGeneration, sessionQueryBoundary],
  )
  const reconcileSession = useCallback((): Promise<SessionPayload | null> => {
    const expected = { mode: sessionMode, token }
    const action = resolveSessionRefreshAction({
      currentImportedToken: importedSessionTokenRef.current,
      currentToken: tokenRef.current,
      expected,
      importInFlight: importedMutationsInFlightRef.current > 0,
    })
    if (action !== 'refresh') {
      return Promise.resolve(null)
    }
    return sessionMutations.reconcile()
  }, [sessionMode, sessionMutations, token])

  const refreshAccessToken = useCallback(async (
    expected?: SessionCredentialSnapshot,
  ): Promise<string | null> => {
    const currentToken = tokenRef.current
    const action = resolveSessionRefreshAction({
      currentImportedToken: importedSessionTokenRef.current,
      currentToken,
      expected,
      importInFlight: importedMutationsInFlightRef.current > 0,
    })
    if (action === 'refresh') return sessionMutations.refresh()
    if (currentToken && action === 'clear-imported') {
      // A pasted dump never contains the httpOnly refresh credential. Do not
      // pair its bearer with whichever cookie happens to be in this WebView.
      await clearImportedSession(currentToken)
    }
    return null
  }, [clearImportedSession, sessionMutations])

  const readSessionCredential = useCallback((): SessionCredentialSnapshot => {
    const currentToken = tokenRef.current
    return {
      mode: currentToken && importedSessionTokenRef.current === currentToken
        ? 'imported'
        : 'renewable',
      token: currentToken,
    }
  }, [])

  const refreshSessionFor = useCallback(async (
    expected: SessionCredentialSnapshot,
  ): Promise<void> => {
    const isCurrent = (): boolean => isSessionCredentialCurrent({
      currentImportedToken: importedSessionTokenRef.current,
      currentToken: tokenRef.current,
      expected,
    })
    if (!isCurrent()) return
    setSessionState((current) => current === 'authenticated' ? current : 'loading')
    let snapshot: Awaited<ReturnType<typeof authApi.fetchSession>>
    try {
      snapshot = await authApi.fetchSession(expected.token)
    } catch (error) {
      if (!isCurrent()) return
      throw error
    }
    if (!isCurrent()) return

    if (snapshot.kind === 'unauthenticated') {
      // The access token may simply have expired — try the refresh cookie before
      // giving up, so a returning user with a live refresh token stays signed in.
      await refreshAccessToken(expected)
      return
    }

    if (snapshot.kind === 'bootstrap') {
      await sessionQueryBoundary.clear()
      if (!isCurrent()) return
      setBootstrapState(snapshot.bootstrap)
      meRef.current = null
      setMe(null)
      setSessionState('bootstrap')
      return
    }

    setBootstrapState(null)
    meRef.current = snapshot.me
    setMe(snapshot.me)
    setSessionState('authenticated')
  }, [refreshAccessToken, sessionQueryBoundary])

  const refreshSession = useCallback(
    (): Promise<void> => refreshSessionFor(readSessionCredential()),
    [readSessionCredential, refreshSessionFor],
  )

  // A network outage, rate limit, or server error during restore is not a
  // logout. Keep the bearer token in localStorage and retry until the API is
  // reachable. An explicit refresh 401 resolves normally after clearSession,
  // so it does not enter this retry loop.
  useEffect(() => {
    const expected = readSessionCredential()
    let cancelled = false
    let restoring = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const restoreSession = async (): Promise<void> => {
      if (cancelled || restoring) return
      restoring = true
      try {
        await refreshSessionFor(expected)
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
  }, [readSessionCredential, refreshSessionFor])

  useAccessTokenRenewal({
    clearImportedSession,
    refreshAccessToken,
    sessionMode,
    token,
  })

  const applyMeResponse = (nextMe: MeResponse): void => {
    if (!isCurrentSessionResponse(meRef.current, nextMe)) return
    meRef.current = nextMe
    setMe(nextMe)
    setBootstrapState(null)
    setSessionState('authenticated')
  }

  const bootstrap = async (input: BootstrapInput): Promise<void> => {
    await sessionMutations.run(() => authApi.bootstrap(input))
  }

  const devLogin = async (): Promise<void> => {
    await sessionMutations.run(() => authApi.devLogin())
  }

  const importAccessToken = useCallback(async (accessToken: string): Promise<void> => {
    importedMutationsInFlightRef.current += 1
    importedApplyTracker.add(accessToken)
    try {
      await sessionMutations.run(
        () => resolveImportedSession(accessToken, authApi.fetchSession),
      )
    } finally {
      importedApplyTracker.delete(accessToken)
      importedMutationsInFlightRef.current -= 1
    }
  }, [importedApplyTracker, sessionMutations])

  const login = async (input: LoginInput): Promise<void> => {
    await sessionMutations.run(() => authApi.login(input))
  }

  const recoveryExchange = async (
    input: ExternalLoginInput,
    expectedWorkspace: ExpectedWorkspaceTarget,
  ): Promise<SessionPayload> => {
    if (input.providerId !== 'uoa') {
      throw new Error('Workspace session recovery is only supported for the UOA provider.')
    }
    // The bearer AND the source session are captured lexically inside the
    // queued thunk — immediately before the request is sent — so the
    // classification compares against the session that is current when the
    // mutation actually runs, not when it was enqueued. The guard closure
    // reads that same lexical binding for BOTH the direct payload and the one
    // opaque-refresh winner, whose raw response carries no request-local
    // proof — nothing is ever attached to the payload itself.
    let capturedSource: ReturnType<typeof captureWorkspaceSessionSource> = null
    return sessionMutations.runGuarded(
      () => {
        const currentToken = tokenRef.current
        if (typeof currentToken !== 'string' || currentToken.length === 0) {
          throw new Error('Workspace session recovery requires an active session.')
        }
        const currentMe = meRef.current
        if (!currentMe) {
          throw new Error('Workspace session recovery requires an active session.')
        }
        const source = captureWorkspaceSessionSource(currentMe)
        if (!source) {
          throw new Error('Workspace session recovery is only supported for the UOA provider.')
        }
        capturedSource = source
        const recoveryInput: RecoverWorkspaceSessionInput = {
          code: input.code,
          codeVerifier: input.codeVerifier,
          expectedWorkspace,
          providerId: 'uoa',
          redirectUri: input.redirectUri,
          ...(input.theme === undefined ? {} : { theme: input.theme }),
        }
        return authApi.recoverWorkspaceSession(currentToken, recoveryInput)
      },
      (payload) => {
        // Defense in depth behind the API's pre-issuance rejection, as a
        // three-way classification against the lexically captured source:
        // exact target succeeds; the preserved source session is applied but
        // the recovery rejects as a non-switch; anything else is foreign. If
        // the thunk never captured a source the guard fails closed (foreign).
        if (!capturedSource) {
          return {
            kind: 'foreign',
            message: 'The renewed session could not be verified. Try switching again.',
          }
        }
        return classifyWorkspaceSessionPayload(payload, expectedWorkspace, capturedSource)
      },
    )
  }

  const switchContext = async (input: SwitchContextInput): Promise<void> => {
    if (
      tokenRef.current
      && importedSessionTokenRef.current === tokenRef.current
    ) {
      throw new Error(IMPORTED_SESSION_SCOPE_MESSAGE)
    }
    await sessionMutations.run(() => authApi.switchContext(tokenRef.current, input))
  }

  const switchUoaWorkspace = async (input: SwitchUoaWorkspaceInput): Promise<void> => {
    if (
      tokenRef.current
      && importedSessionTokenRef.current === tokenRef.current
    ) {
      throw new Error(IMPORTED_SESSION_SCOPE_MESSAGE)
    }
    await sessionMutations.run(() => authApi.switchUoaWorkspace(tokenRef.current, input))
  }

  const logout = async (): Promise<void> => {
    const initiating = readSessionCredential()
    const pendingImportedTokens = importedApplyTracker.tokens()
    await sessionMutations.terminate(async (latestPayload) => {
      const ending = resolveTerminatingSessionCredential({
        initiating,
        pendingImportedTokens,
        terminalToken: latestPayload?.token ?? null,
      })
      await finalizeSessionLogout({
        mode: ending.mode,
        nativeWebView: isReactNativeWebView(),
        revokeRemoteSession: () => authApi.logout(ending.token),
        unregisterNativePush: unregisterNativePushDevice,
      })
    })
  }

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      applyMeResponse,
      bootstrap,
      bootstrapState,
      devLogin,
      importAccessToken,
      login,
      logout,
      me,
      reconcileSession,
      recoveryExchange,
      refreshAccessToken,
      refreshSession,
      sessionMode,
      sessionState,
      switchContext,
      switchUoaWorkspace,
      token,
    }),
    [
      bootstrapState,
      importAccessToken,
      me,
      reconcileSession,
      refreshAccessToken,
      refreshSession,
      sessionMode,
      sessionState,
      token,
    ],
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
