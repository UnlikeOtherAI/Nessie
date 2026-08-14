import { useCallback, useEffect, useRef, useState } from 'react'
import { ADMIN_URL } from '../config'

// If the admin never reports itself mounted (it posts a `nessie:route` message on
// boot) within this window after a load finishes, the WebView is blank/white —
// reload it with a cache-bust. WKWebView can serve a stale cached index.html (e.g.
// one referencing a JS bundle that 404s after a deploy), which boots to white; a
// changed URL forces a fresh fetch. Capped so a genuinely broken page can't loop.
const BOOT_TIMEOUT_MS = 9000
const MAX_BOOT_RETRIES = 4

export type WebviewBootRecovery = {
  // Remounts the WebView — Android's killed render process leaves the
  // instance unusable until recreated.
  remountWebview: () => void
  // Stable props for the WebView: remount key, cache-busted source, and the
  // load-event handlers that arm and disarm the blank-screen watchdog.
  webviewBootProps: {
    key: number
    onError: () => void
    onHttpError: () => void
    onLoadEnd: () => void
    onLoadStart: () => void
  }
  fullRefreshWebView: () => void
  // The admin's `nessie:route` message doubles as the "booted" signal that
  // defuses the watchdog.
  noteAdminBooted: () => void
  sourceUri: string
}

// Owns the WebView's blank-screen recovery: the boot watchdog timer, the
// retry counter, the cache-busting reload URL, and the remount key. The
// Shell renders exactly what this returns and reports route messages back
// through noteAdminBooted.
export const useWebviewBootRecovery = (): WebviewBootRecovery => {
  const [webviewKey, setWebviewKey] = useState(0)
  // Changing the loaded URL forces WKWebView to fetch a fresh index.html instead of
  // a cached (possibly stale, asset-404ing) one that boots to a blank white screen.
  const [reloadNonce, setReloadNonce] = useState(0)
  const [reloadPath, setReloadPath] = useState<string | null>(null)
  const adminBooted = useRef(false)
  const bootRetries = useRef(0)
  const bootTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearBootTimer = useCallback((): void => {
    if (bootTimer.current) {
      clearTimeout(bootTimer.current)
      bootTimer.current = null
    }
  }, [])

  const sourceUri = reloadNonce === 0
    ? ADMIN_URL
    : (() => {
      const url = new URL(reloadPath ?? '/', ADMIN_URL)
      url.searchParams.set('__boot', String(reloadNonce))
      return url.toString()
    })()

  const loadFreshWebView = useCallback((): void => {
    clearBootTimer()
    setReloadNonce((nonce) => nonce + 1)
  }, [clearBootTimer])

  const fullRefreshWebView = useCallback((): void => {
    adminBooted.current = false
    bootRetries.current = 0
    setReloadPath(null)
    loadFreshWebView()
    setWebviewKey((key) => key + 1)
  }, [loadFreshWebView])

  // Reload the WebView fresh after a blank/failed load, capped so a persistently
  // broken page doesn't loop forever.
  const recoverBlankWebView = useCallback((): void => {
    if (adminBooted.current || bootRetries.current >= MAX_BOOT_RETRIES) return
    bootRetries.current += 1
    loadFreshWebView()
    setWebviewKey((key) => key + 1)
  }, [loadFreshWebView])

  const noteAdminBooted = useCallback((): void => {
    adminBooted.current = true
    bootRetries.current = 0
    clearBootTimer()
  }, [clearBootTimer])

  useEffect(() => clearBootTimer, [clearBootTimer])

  const remountWebview = useCallback((): void => {
    setWebviewKey((key) => key + 1)
  }, [])

  return {
    remountWebview,
    fullRefreshWebView,
    noteAdminBooted,
    sourceUri,
    webviewBootProps: {
      key: webviewKey,
      onError: recoverBlankWebView,
      onHttpError: recoverBlankWebView,
      onLoadEnd: () => {
        clearBootTimer()
        if (!adminBooted.current) {
          bootTimer.current = setTimeout(recoverBlankWebView, BOOT_TIMEOUT_MS)
        }
      },
      onLoadStart: () => {
        adminBooted.current = false
      },
    },
  }
}
