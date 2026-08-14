import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

// If the admin never reports itself mounted (it posts a `nessie:route` message on
// boot) within this window after a load finishes, the WebView is blank/white —
// reload it with a cache-bust. WKWebView can serve a stale cached index.html (e.g.
// one referencing a JS bundle that 404s after a deploy), which boots to white; a
// changed URL forces a fresh fetch. Capped so a genuinely broken page can't loop.
const BOOT_TIMEOUT_MS = 9000
const MAX_BOOT_RETRIES = 4

export type NativeBootRecovery = {
  // Reload after a blank/failed load, capped so a persistently broken page
  // doesn't loop forever.
  recoverBlankWebView: () => void
  // Force a fresh instance (Android render-process death makes the current
  // one unusable). Uncapped: this is not the blank-load watchdog.
  remountWebView: () => void
  // The admin reported itself mounted (`nessie:route`): defuse the watchdog.
  markBooted: () => void
  // WebView load lifecycle notifications that arm the watchdog.
  noteLoadEnd: () => void
  noteLoadStart: () => void
  // Native-frame full refresh: remount the WebView with a cache-busting URL at
  // the current path instead of asking the hosted page to reload itself.
  fullRefreshWebView: () => void
  // Bumping this remounts the WebView — used to recover Android after its render
  // process is killed (the instance is unusable until recreated).
  webviewKey: number
  // Changing the loaded URL forces WKWebView to fetch a fresh index.html instead
  // of a cached (possibly stale, asset-404ing) one that boots to a blank screen.
  reloadNonce: number
  reloadPath: string | null
}

export const useNativeBootRecovery = (
  currentPathRef: MutableRefObject<string | null>,
): NativeBootRecovery => {
  const [webviewKey, setWebviewKey] = useState(0)
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

  const loadFreshWebView = useCallback((): void => {
    clearBootTimer()
    setReloadNonce((nonce) => nonce + 1)
  }, [clearBootTimer])

  const recoverBlankWebView = useCallback((): void => {
    if (adminBooted.current || bootRetries.current >= MAX_BOOT_RETRIES) return
    bootRetries.current += 1
    loadFreshWebView()
    setWebviewKey((key) => key + 1)
  }, [loadFreshWebView])

  const markBooted = useCallback((): void => {
    adminBooted.current = true
    bootRetries.current = 0
    clearBootTimer()
  }, [clearBootTimer])

  const noteLoadStart = useCallback((): void => {
    adminBooted.current = false
  }, [])

  const noteLoadEnd = useCallback((): void => {
    // Page finished loading; give the admin a window to report itself mounted
    // before assuming the WebView is blank/white.
    clearBootTimer()
    if (!adminBooted.current) {
      bootTimer.current = setTimeout(recoverBlankWebView, BOOT_TIMEOUT_MS)
    }
  }, [clearBootTimer, recoverBlankWebView])

  const fullRefreshWebView = useCallback((): void => {
    adminBooted.current = false
    bootRetries.current = 0
    setReloadPath(currentPathRef.current)
    loadFreshWebView()
    setWebviewKey((key) => key + 1)
  }, [currentPathRef, loadFreshWebView])

  useEffect(() => () => {
    if (bootTimer.current) clearTimeout(bootTimer.current)
  }, [])

  const remountWebView = useCallback((): void => {
    setWebviewKey((key) => key + 1)
  }, [])

  return {
    recoverBlankWebView,
    remountWebView,
    markBooted,
    noteLoadEnd,
    noteLoadStart,
    fullRefreshWebView,
    webviewKey,
    reloadNonce,
    reloadPath,
  }
}
