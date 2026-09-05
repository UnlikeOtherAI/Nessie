import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { MeResponse } from '@nessie/schemas'
import {
  createAuthSessionApi,
  createSessionMutationCoordinator,
  type AuthSessionState,
  type BootstrapInput,
  type BootstrapModeResponse,
  type ExpectedTeamTarget,
  type ExternalLoginInput,
  type LoginInput,
  type SessionPayload,
  type SwitchContextInput,
  type SwitchUoaTeamInput,
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
import { clearBlobCache } from '../lib/blob-cache'
import { getSessionClientType } from '../lib/session-client'
import {
  clearSessionIfCurrent,
  createImportedSessionApplyTracker,
  isSessionCredentialCurrent,
  resolveSessionRefreshAction,
  resolveTerminatingSessionCredential,
  type SessionCredentialSnapshot,
} from '../lib/imported-session-policy'
import { resolveImportedSession } from '../lib/session-debug-import'
import {
  NATIVE_PUSH_UNREGISTER_EVENT,
} from '../lib/native-push-registration'
import { isReactNativeWebView } from '../lib/native-shell'
import { createAmbientRefreshGateHost } from './ambient-refresh-gate-host'
import {
  createSessionQueryBoundary,
  isCurrentSessionResponse,
} from './auth-session-query-reset'
import { isSameMeResponse } from './me-response-identity'
import { performTerminalSessionLogout } from './terminal-session-logout'
import { useAccessTokenRenewal } from './useAccessTokenRenewal'
import { useSessionRestoration } from './useSessionRestoration'
import { useTeamSessionRecovery } from './useTeamSessionRecovery'

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
   * Complete an external-auth code exchange for a team-switch
   * reauthorization. Unlike `login` this never applies the exchanged session
   * until the payload proves it is scoped to exactly `expectedTeam`; a
   * mismatch leaves the current session, token, and query cache untouched.
   * Returns the applied payload.
   */
  recoveryExchange: (
    input: ExternalLoginInput,
    expectedTeam: ExpectedTeamTarget,
  ) => Promise<SessionPayload>
  refreshAccessToken: (expected?: SessionCredentialSnapshot) => Promise<string | null>
  refreshSession: () => Promise<void>
  sessionMode: StoredTokenMode
  sessionState: AuthSessionState
  switchContext: (input: SwitchContextInput) => Promise<void>
  switchUoaTeam: (input: SwitchUoaTeamInput) => Promise<void>
  token: string | null
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

const unregisterNativePushDevice = (): Promise<void> =>
  new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent(NATIVE_PUSH_UNREGISTER_EVENT, { detail: { complete: resolve } }),
    )
  })

// Admin (web) supplies the Vite-resolved base URL; @nessie/client-core stays
// env-agnostic. localStorage is the web TokenStore backing.
const authApi = createAuthSessionApi(getBaseUrl(), { sessionClient: getSessionClientType })

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
    // Authed image bytes were fetched with the session that is ending; the
    // blob cache outlives React state, so it is cleared with the query cache
    // rather than left for the next person signing in on this tab.
    clearBlobCache()
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

  // Synchronously remove every local bearer/auth reference; safe to call
  // before returning control to a remote finalizer.
  const commitSessionClear = useCallback((): void => {
    tokenRef.current = null
    importedSessionTokenRef.current = null
    meRef.current = null
    setToken(null)
    setMe(null)
    setBootstrapState(null)
    setSessionState('unauthenticated')
    try {
      clearStoredToken()
    } catch {
      // In-memory auth is already gone when browser storage is unavailable.
    }
  }, [])

  const clearSession = useCallback((): Promise<void> => {
    // Start cancelling tenant work, then synchronously remove every local
    // bearer/auth reference before returning control to a remote finalizer.
    const clearingQueries = sessionQueryBoundary.clear().catch(() => undefined)
    commitSessionClear()
    return clearingQueries
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
  // login or team recovery — after React re-renders — runs against a
  // fresh coordinator. An ordinary refresh that returns null is not terminal
  // and never bumps it.
  const [coordinatorGeneration, setCoordinatorGeneration] = useState(0)
  // Synchronous ambient gate host, outside React state so it is exact even
  // before a re-render commits. From the terminal-START hook (the moment a
  // logout or foreign fence begins — before its awaited DELETE/revocation)
  // until a successfully APPLIED explicit login/bootstrap/dev login or valid
  // explicit recovery, the public refresh/reconcile facades refuse, so a
  // remount mid-finalization cannot consume an ambient refresh cookie whose
  // logout may still be pending or may have failed. Explicit run/runGuarded
  // mutations are never gated, so a later explicit login still works and its
  // apply reopens the gate synchronously — ahead of React's commit. The gate
  // also persists beside the token store and initializes from that marker,
  // so a full remount (web page, Tauri, mobile WebView) of a terminated-
  // but-not-revoked session starts blocked.
  const ambientRefreshGate = useMemo(() => createAmbientRefreshGateHost(), [])
  // Login, startup restore, every API 401, and team switching share this
  // exact coordinator. Both refresh cookies are single-use, so no other path
  // may mutate the session concurrently or apply an older response afterwards.
  const sessionMutations = useMemo(
    () =>
      createSessionMutationCoordinator({
        applySession,
        beforeApply: sessionQueryBoundary.beforeApply,
        clearLocal: clearSession,
        clearSession,
        // A foreign session that missed its guarded target must never live on
        // beside the rotated HTTP-only cookie family: revoke that exact family
        // using the foreign payload's own bearer as the proof.
        onForeignSession: async (payload) => {
          await authApi.logout(payload.token)
        },
        // The ambient gate is set by onTerminalStart, the moment terminate
        // or a foreign fence begins — before any awaited DELETE/revocation —
        // so a remount during that pending work already reads the persisted
        // fence. This post-clear notification only retires the coordinator:
        // bump the generation so a later explicit login/recovery, after
        // React re-renders, builds a fresh one.
        onTerminalStart: ambientRefreshGate.onTerminalStart,
        onTerminal: () => {
          setCoordinatorGeneration((generation) => generation + 1)
        },
        isAmbientRefreshBlocked: ambientRefreshGate.isBlocked,
        refresh: authApi.refresh,
      }),
    // coordinatorGeneration is not read inside the factory; it only re-runs
    // the memo after the previous coordinator went terminal. That is exactly
    // the "unnecessary dependency" exhaustive-deps objects to, and removing it
    // would leave a retired coordinator in place — so the rule is silenced for
    // this array only. Every other entry here is a real read: keep them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ambientRefreshGate, applySession, clearSession, coordinatorGeneration, sessionQueryBoundary],
  )
  const reconcileSession = useCallback((): Promise<SessionPayload | null> => {
    // A terminal fence/logout ends every ambient path at once, synchronously:
    // no refresh-cookie consumption until an explicit login/recovery applies.
    if (ambientRefreshGate.isBlocked()) return Promise.resolve(null)
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
  }, [ambientRefreshGate, sessionMode, sessionMutations, token])

  const refreshAccessToken = useCallback(async (
    expected?: SessionCredentialSnapshot,
  ): Promise<string | null> => {
    if (ambientRefreshGate.isBlocked()) return null
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
  }, [ambientRefreshGate, clearImportedSession, sessionMutations])

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
    // A terminal fence/logout ends every ambient path at once, synchronously:
    // no startup-restore fetch, no refresh-cookie consumption.
    if (ambientRefreshGate.isBlocked()) return
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
  }, [ambientRefreshGate, refreshAccessToken, sessionQueryBoundary])

  const refreshSession = useCallback(
    (): Promise<void> => refreshSessionFor(readSessionCredential()),
    [readSessionCredential, refreshSessionFor],
  )

  useSessionRestoration({ ambientRefreshGate, readSessionCredential, refreshSessionFor })

  useAccessTokenRenewal({
    clearImportedSession,
    refreshAccessToken,
    sessionMode,
    token,
  })

  const applyMeResponse = useCallback((nextMe: MeResponse): void => {
    if (!isCurrentSessionResponse(meRef.current, nextMe)) return
    // A response that says exactly what the current one says is not a change.
    // `me` is read by every screen, so republishing an equal object would
    // re-render the whole tree — and revert optimistic state that is still
    // ahead of the server — for nothing.
    if (isSameMeResponse(meRef.current, nextMe)) return
    meRef.current = nextMe
    setMe(nextMe)
    setBootstrapState(null)
    setSessionState('authenticated')
  }, [])

  const bootstrap = useCallback(async (input: BootstrapInput): Promise<void> => {
    await sessionMutations.run(() => authApi.bootstrap(input))
    // Applied explicit session creation reopens ambient refresh.
    ambientRefreshGate.reopen()
  }, [ambientRefreshGate, sessionMutations])

  const devLogin = useCallback(async (): Promise<void> => {
    await sessionMutations.run(() => authApi.devLogin())
    ambientRefreshGate.reopen()
  }, [ambientRefreshGate, sessionMutations])

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

  const login = useCallback(async (input: LoginInput): Promise<void> => {
    await sessionMutations.run(() => authApi.login(input))
    ambientRefreshGate.reopen()
  }, [ambientRefreshGate, sessionMutations])

  const { recoveryExchange, switchContext, switchUoaTeam } = useTeamSessionRecovery({
    ambientRefreshGate,
    authApi,
    importedSessionTokenRef,
    meRef,
    sessionMutations,
    tokenRef,
  })

  const logout = useCallback(async (): Promise<void> => {
    // Capture the ending credential before terminate synchronously clears
    // tokenRef; the terminal payload's bearer (if any) still wins. Native
    // cleanup must start while the authenticated bridge is still mounted, so
    // its gate reads the initiating snapshot (an imported bearer never
    // registered native push and never revokes a remote session).
    const initiating = readSessionCredential()
    const pendingImportedTokens = importedApplyTracker.tokens()
    await performTerminalSessionLogout({
      currentBearer: initiating.token,
      isNative: isReactNativeWebView() && initiating.mode !== 'imported',
      logout: async (bearer) => {
        const ending = resolveTerminatingSessionCredential({
          initiating,
          pendingImportedTokens,
          terminalToken: bearer,
        })
        if (ending.mode === 'imported') return
        await authApi.logout(ending.token)
      },
      terminate: (finalize) => sessionMutations.terminate(finalize),
      unregisterNative: unregisterNativePushDevice,
    })
  }, [importedApplyTracker, readSessionCredential, sessionMutations])

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
      switchUoaTeam,
      token,
    }),
    [
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
      switchUoaTeam,
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
