import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { appKeys } from '../../lib/query-keys'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AppDetailRecord, McpServerScopeType } from '@nessie/schemas'

import { normalizeConnectError } from '../../components/features/apps/connect-error-copy'
import {
  CONNECT_AUTHORIZATION_TIMEOUT_MS,
  CONNECT_STILL_WAITING_MS,
  connectMarkerKey,
  connectReducer,
  initialConnectState,
  parseAppConnectResponse,
  parseConnectCompletionMessage,
  parseConnectMarker,
  resolveApiOrigin,
  serializeConnectMarker,
  type AppConnectResponse,
  type ConnectState,
} from '../../components/features/apps/connect-flow'
import {
  createWindowAuthLauncher,
  type AuthHandle,
  type ExternalAuthLauncher,
} from '../../components/features/apps/external-auth-launcher'
import { getBaseUrl } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { APPS_QUERY_KEY } from './hooks'

/**
 * Driving the universal Connect flow.
 *
 * The decisions live in `connect-flow.ts`; this file supplies the outside world
 * — one POST, a sign-in window, a status read — and nothing else. The reason it
 * is worth the separation is that every hard case here is a *timing* case, and
 * timing is exactly what an effect makes untestable.
 *
 * Completion arrives by two independent routes on purpose. The callback page
 * posts a fixed message to its opener, which is instant; but a popup can land in
 * another browser process, an extension can eat the message, and a phone leaves
 * the page entirely — so a status read on focus (and on return to visibility) is
 * the route that always works. Whichever answers first wins, and neither is
 * trusted on its own: the message says the callback ran, the account row says
 * the connection exists.
 */

export type AppConnectScope = {
  /** Absent for `user` scope, where the server resolves the caller. */
  scopeId?: string
  scopeType: McpServerScopeType
}

export type AppConnectFlow = {
  /** Start a connect for this scope. */
  connect: (scope: AppConnectScope) => void
  /** Abandon the flow and put the panel away. */
  dismiss: () => void
  /** "Didn't open? Open it again" — re-issues the same authorization URL. */
  reopenAuthorization: () => void
  /** Run the last connect again after an error. */
  retry: () => void
  state: ConnectState
}

export type CustomAppInput = {
  name?: string
  url: string
}

export type CustomAppResult = {
  app: AppDetailRecord
  appId: string
  outcome: AppConnectResponse
}

/** How often we look at the sign-in window to see whether it went away. */
const POPUP_WATCH_INTERVAL_MS = 700
/** Status reads while verifying, and the gap between them. */
const VERIFY_ATTEMPTS = 5
const VERIFY_INTERVAL_MS = 900

const readMarker = (slug: string, now: number) => {
  try {
    return parseConnectMarker(sessionStorage.getItem(connectMarkerKey(slug)), now)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). A flow that
    // cannot leave a marker still works; it just looks idle on return.
    return null
  }
}

/**
 * `POST /api/apps/:slug/connect`.
 *
 * Exposed on its own because the response is the whole contract — the three
 * outcomes a caller may have to render — and because a caller that only wants
 * to kick a connect off (a wizard, a retry from elsewhere) should not have to
 * take the window machinery with it. The body is unvalidated at this layer; the
 * flow parses it before believing it.
 */
export const useConnectApp = (slug: string) => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (scope: AppConnectScope) =>
      apiClient.post<unknown>(`/api/apps/${encodeURIComponent(slug)}/connect`, {
        scopeId: scope.scopeId,
        scopeType: scope.scopeType,
      }),
  })
}

/**
 * Adds an app by address and starts its first user-scoped connection. The
 * Apps surface owns this doorway, so it shares the catalogue cache contract
 * with every other connection mutation.
 */
export const useAddCustomApp = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CustomAppInput) =>
      apiClient.post<CustomAppResult>('/api/apps/custom', input),
    onSuccess: (result) => {
      queryClient.setQueryData(appKeys.detail(result.app.slug ?? result.app.id), result.app)
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}

/**
 * Stores one person's key for a pending app connection. The server accepts the
 * plaintext once and returns no secret material; all app reads are then
 * invalidated so the connection state re-renders from the authoritative row.
 */
export const useSetAppConnectionSecret = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { connectionId: string; secret: string }) =>
      apiClient.post<{ placement: string }>(`/api/mcp/instances/${input.connectionId}/secret`, {
        secret: input.secret,
        shared: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    },
  })
}

export const useAppConnectFlow = (input: {
  /** Injected by tests and by a native shell; the web popup is the default. */
  launcher?: ExternalAuthLauncher
  slug: string
}): AppConnectFlow => {
  const { slug } = input
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const connectApp = useConnectApp(slug)
  const [state, dispatch] = useReducer(connectReducer, initialConnectState)

  const launcher = useMemo(
    () => input.launcher ?? createWindowAuthLauncher(window),
    [input.launcher],
  )
  // The single origin a completion message may come from: the API serves the
  // callback page, and in production that is not the admin's origin.
  const apiOrigin = useMemo(
    () => resolveApiOrigin(getBaseUrl(), window.location.origin),
    [],
  )

  const handleRef = useRef<AuthHandle | null>(null)
  const scopeRef = useRef<AppConnectScope | null>(null)
  const startedAtRef = useRef<number>(0)

  const forgetMarker = useCallback(() => {
    try {
      sessionStorage.removeItem(connectMarkerKey(slug))
    } catch {
      // See readMarker: storage is a convenience, never a precondition.
    }
  }, [slug])

  const rememberMarker = useCallback(
    (connectionId: string, authorizationUrl: string | null, startedAt: number) => {
      try {
        sessionStorage.setItem(
          connectMarkerKey(slug),
          serializeConnectMarker({ authorizationUrl, connectionId, startedAt }),
        )
      } catch {
        // See readMarker.
      }
    },
    [slug],
  )

  /**
   * Read the app back and answer whether this account is connected.
   *
   * The freshly-read detail is written into the cache the page already reads
   * from, so the hero flips the moment the answer arrives rather than after a
   * second round trip. Failures are silent by design: a status read is a poll,
   * and a dropped one is answered by the next focus or the next tick.
   */
  const probeStatus = useCallback(
    async (connectionId: string): Promise<boolean> => {
      try {
        const detail = await apiClient.get<AppDetailRecord>(
          `/api/apps/${encodeURIComponent(slug)}`,
        )
        queryClient.setQueryData(appKeys.detail(slug), detail)
        const connected = detail.connections.some(
          (connection) => connection.id === connectionId && connection.status === 'connected',
        )
        if (connected) dispatch({ connected: true, type: 'connection_observed' })
        return connected
      } catch {
        return false
      }
    },
    [apiClient, queryClient, slug],
  )

  const launch = useCallback(
    (authorizationUrl: string) => {
      const handle = launcher.open(authorizationUrl)
      handleRef.current = handle
      // Null is a state, not a failure: the panel offers the same URL as a link.
      dispatch({ opened: handle !== null, type: 'launcher_result' })
    },
    [launcher],
  )

  const begin = useCallback(
    async (scope: AppConnectScope) => {
      scopeRef.current = scope
      startedAtRef.current = Date.now()
      dispatch({ type: 'start' })
      try {
        const result = parseAppConnectResponse(await connectApp.mutateAsync(scope))
        if (!result) {
          // A body this client does not understand is not a success. Reading it
          // optimistically would tell somebody they were connected when the
          // server said something else entirely.
          dispatch({ code: 'CONNECTION_FAILED', detail: null, type: 'failed' })
          return
        }
        dispatch({ result, type: 'server_result' })
        if (result.status === 'authorize') {
          rememberMarker(result.connectionId, result.authorizationUrl, startedAtRef.current)
          launch(result.authorizationUrl)
        }
      } catch (error) {
        const { code, detail } = normalizeConnectError(error)
        dispatch({ code, detail, type: 'failed' })
      }
    },
    [connectApp, launch, rememberMarker],
  )

  // A flow this tab started and walked away from. Without this the page looks
  // idle on return from the provider, which reads as "nothing happened".
  useEffect(() => {
    const marker = readMarker(slug, Date.now())
    if (!marker) return
    startedAtRef.current = marker.startedAt
    dispatch({
      authorizationUrl: marker.authorizationUrl,
      connectionId: marker.connectionId,
      type: 'resume',
      waitedMs: Date.now() - marker.startedAt,
    })
  }, [slug])

  // ─── Waiting for the provider ─────────────────────────────────────────────
  //
  // Deliberately keyed on the phase and the account only. `waitedMs` changes
  // while this runs, and depending on it would restart every timer each time a
  // threshold fired — which is how a 120 s stop becomes a stop that never comes.
  const { connectionId, phase } = state
  useEffect(() => {
    if (phase !== 'awaiting_authorization' || !connectionId) return undefined

    const onMessage = (event: MessageEvent<unknown>) => {
      // Origin first: a payload can be forged, an origin cannot.
      if (event.origin !== apiOrigin) return
      const message = parseConnectCompletionMessage(event.data)
      if (!message) return
      dispatch({ ok: message.ok, type: 'authorization_reported' })
    }
    const onReturn = () => {
      // Fires for a popup dismissed without a message, for a phone coming back
      // from the system browser, and for a plain alt-tab.
      if (document.visibilityState === 'hidden') return
      void probeStatus(connectionId)
    }

    window.addEventListener('message', onMessage)
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)

    const watch = window.setInterval(() => {
      // Only a window we actually opened can be observed closing; a native or
      // resumed flow simply has nothing to watch and relies on the reads above.
      if (handleRef.current?.isClosed() === true) {
        handleRef.current = null
        dispatch({ type: 'authorization_closed' })
      }
    }, POPUP_WATCH_INTERVAL_MS)

    const elapsed = Date.now() - startedAtRef.current
    const slowNote = window.setTimeout(
      () => dispatch({ elapsedMs: Date.now() - startedAtRef.current, type: 'waited' }),
      Math.max(0, CONNECT_STILL_WAITING_MS - elapsed),
    )
    const expiry = window.setTimeout(
      () => dispatch({ elapsedMs: Date.now() - startedAtRef.current, type: 'waited' }),
      Math.max(0, CONNECT_AUTHORIZATION_TIMEOUT_MS - elapsed),
    )

    // One read straight away, so a sign-in that finished between the server's
    // answer and these listeners is not waited on for two minutes.
    void probeStatus(connectionId)

    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
      window.clearInterval(watch)
      window.clearTimeout(slowNote)
      window.clearTimeout(expiry)
    }
  }, [apiOrigin, connectionId, phase, probeStatus])

  // ─── Confirming ───────────────────────────────────────────────────────────
  //
  // Entered from either completion route. The account is read a few times
  // because the callback returns the moment the exchange succeeds and the
  // instance is written a beat later; running out of reads is what turns a
  // closed window into "cancelled" and a reported success into a failure.
  useEffect(() => {
    if (phase !== 'verifying' || !connectionId) return undefined

    let attempts = 0
    let cancelled = false
    let timer = 0
    const tick = async () => {
      if (cancelled) return
      attempts += 1
      const connected = await probeStatus(connectionId)
      if (connected || cancelled) return
      if (attempts >= VERIFY_ATTEMPTS) {
        dispatch({ type: 'verification_exhausted' })
        return
      }
      timer = window.setTimeout(() => void tick(), VERIFY_INTERVAL_MS)
    }
    timer = window.setTimeout(() => void tick(), 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [connectionId, phase, probeStatus])

  // ─── Settling ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'connected' && phase !== 'error' && phase !== 'needs_secret') return
    forgetMarker()
    handleRef.current?.close()
    handleRef.current = null
    if (phase === 'connected') {
      // Every catalogue read, from one place: the card in the grid, the shelf
      // counts, and the detail this flow just refreshed.
      void queryClient.invalidateQueries({ queryKey: APPS_QUERY_KEY })
    }
  }, [forgetMarker, phase, queryClient])

  const connect = useCallback((scope: AppConnectScope) => void begin(scope), [begin])

  const retry = useCallback(() => {
    const scope = scopeRef.current
    if (scope) void begin(scope)
  }, [begin])

  const reopenAuthorization = useCallback(() => {
    const url = state.authorizationUrl
    if (!url) return
    handleRef.current?.close()
    launch(url)
  }, [launch, state.authorizationUrl])

  const dismiss = useCallback(() => {
    handleRef.current?.close()
    handleRef.current = null
    forgetMarker()
    dispatch({ type: 'reset' })
  }, [forgetMarker])

  return { connect, dismiss, reopenAuthorization, retry, state }
}
