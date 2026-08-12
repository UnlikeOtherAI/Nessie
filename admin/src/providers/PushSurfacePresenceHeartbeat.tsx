import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { PushSurfaceSchema, type PushSurface } from '@nessie/schemas'
import { PUSH_SURFACE_CHANGE_EVENT, resolvePushSurface } from '../lib/push-surface'
import { getBaseUrl } from '../lib/api-client'
import { useAuthSession } from './AuthSessionProvider'

const HEARTBEAT_MS = 25_000
const CLIENT_ID_KEY = 'nessie.push-surface-client-id'
const NATIVE_APP_FOREGROUND_EVENT = 'nessie:native-app-foreground'

type NativeAppForegroundWindow = Window & {
  __nessieNativeAppForeground?: boolean
  __nessiePushSurfaceClientId?: string
  ReactNativeWebView?: { postMessage: (message: string) => void }
}

const createClientId = (): string => {
  if (typeof window.crypto?.randomUUID === 'function') {
    return window.crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof window.crypto?.getRandomValues === 'function') {
    window.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const isForeground = (): boolean => {
  const nativeWindow = window as NativeAppForegroundWindow
  if (document.visibilityState !== 'visible' || nativeWindow.__nessieNativeAppForeground === false) {
    return false
  }
  // Native shells report foreground through AppState. A browser must also own
  // window focus: a visible but inactive tab cannot suppress every device's
  // notification for up to the heartbeat window.
  return Boolean(nativeWindow.ReactNativeWebView) || document.hasFocus()
}

const getClientId = (): string => {
  const nativeClientId = (window as NativeAppForegroundWindow).__nessiePushSurfaceClientId
  if (nativeClientId) return nativeClientId
  const stored = window.sessionStorage.getItem(CLIENT_ID_KEY)
  if (stored) return stored
  const clientId = createClientId()
  window.sessionStorage.setItem(CLIENT_ID_KEY, clientId)
  return clientId
}

/**
 * Keeps the server-side delivery worker aware of this foreground browser or
 * native WebView's current push target. It owns no UI or global state.
 */
export const PushSurfacePresenceHeartbeat = () => {
  const { me, token } = useAuthSession()
  const location = useLocation()
  const [foreground, setForeground] = useState(isForeground)
  const clientId = useMemo(getClientId, [])
  // A client-side logical clock is included in every request. It makes the
  // background null signal win even if an earlier foreground request finishes
  // its server-side entitlement check later.
  const heartbeatSequence = useRef(Date.now() * 1_000)
  const surface = useMemo(
    () => resolvePushSurface(location.pathname, location.search),
    [location.pathname, location.search],
  )
  const [reportedSurface, setReportedSurface] = useState<PushSurface | null>(null)
  const effectiveSurface = reportedSurface ?? surface

  const heartbeat = useCallback((nextSurface: ReturnType<typeof resolvePushSurface>) => {
    if (!token) return Promise.resolve()
    heartbeatSequence.current = Math.max(
      heartbeatSequence.current + 1,
      Date.now() * 1_000,
    )
    return fetch(`${getBaseUrl()}/api/push-surfaces/heartbeat`, {
      body: JSON.stringify({
        clientId,
        sequence: heartbeatSequence.current.toString(),
        surface: nextSurface,
      }),
      credentials: 'include',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      keepalive: true,
      method: 'POST',
    }).catch(() => undefined)
  }, [clientId, token])

  useEffect(() => {
    const reportSelectedKnowledgeSurface = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (detail !== null && !PushSurfaceSchema.safeParse(detail).success) return
      const nextSurface = detail as PushSurface | null
      setReportedSurface(nextSurface)
      if (isForeground()) void heartbeat(nextSurface)
    }
    window.addEventListener(PUSH_SURFACE_CHANGE_EVENT, reportSelectedKnowledgeSurface)
    return () => window.removeEventListener(PUSH_SURFACE_CHANGE_EVENT, reportSelectedKnowledgeSurface)
  }, [heartbeat])

  useEffect(() => {
    const refreshVisibility = () => {
      const nextForeground = isForeground()
      // This must be a network call from the lifecycle event itself. Deferring
      // it to the render triggered by setForeground is too late once Safari or
      // a native WebView begins suspending this page.
      if (!nextForeground) void heartbeat(null)
      setForeground(nextForeground)
    }
    const clearForPageHide = () => {
      // Browsers are allowed to retain `visibilityState === 'visible'` while
      // dispatching pagehide. A closing page cannot suppress a push, regardless
      // of that transient state, so this signal is deliberately unconditional.
      void heartbeat(null)
      setForeground(false)
    }
    document.addEventListener('visibilitychange', refreshVisibility)
    window.addEventListener('blur', refreshVisibility)
    window.addEventListener('focus', refreshVisibility)
    window.addEventListener(NATIVE_APP_FOREGROUND_EVENT, refreshVisibility)
    window.addEventListener('pagehide', clearForPageHide)
    return () => {
      document.removeEventListener('visibilitychange', refreshVisibility)
      window.removeEventListener('blur', refreshVisibility)
      window.removeEventListener('focus', refreshVisibility)
      window.removeEventListener(NATIVE_APP_FOREGROUND_EVENT, refreshVisibility)
      window.removeEventListener('pagehide', clearForPageHide)
    }
  }, [heartbeat])

  useEffect(() => {
    if (!me || !token) return undefined
    const reportCurrentSurface = () => heartbeat(foreground ? effectiveSurface : null)

    void reportCurrentSurface()
    const interval = window.setInterval(() => void reportCurrentSurface(), HEARTBEAT_MS)
    return () => window.clearInterval(interval)
  }, [effectiveSurface, foreground, heartbeat, me, token])

  return null
}
