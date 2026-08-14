// The terminal ambient-refresh fence persisted beside the browser token
// store (`../lib/storage`). A logout or foreign-session terminal event clears
// local state, but when its server-side DELETE fails or is swallowed the
// refresh cookie family stays live. An in-memory ref would die with the
// provider: remounting the web page, Tauri shell, or mobile WebView creates a
// fresh provider whose startup restore could then consume that cookie and
// resurrect a terminated session. Persisting the marker in localStorage makes
// the fence survive the remount, so every ambient startup/proactive/public
// refresh and reconcile path stays blocked until an explicit session
// creation succeeds.

const AMBIENT_REFRESH_BLOCKED_KEY = 'nessie.admin.ambient-refresh-blocked'
const BLOCKED_VALUE = '1'

const readLocalStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // SecurityError when storage is denied (e.g. a disabled-storage webview):
    // fall back to the in-memory-only gate rather than crashing the provider.
    return null
  }
}

export const isAmbientRefreshBlocked = (): boolean =>
  readLocalStorage()?.getItem(AMBIENT_REFRESH_BLOCKED_KEY) === BLOCKED_VALUE

// Synchronous by design: onTerminal calls this before any coordinator
// generation bump or re-render could run a restore, so the persisted fence
// is exact even inside the same task.
export const blockAmbientRefresh = (): void => {
  readLocalStorage()?.setItem(AMBIENT_REFRESH_BLOCKED_KEY, BLOCKED_VALUE)
}

// Called only after a successfully APPLIED explicit login, bootstrap,
// dev login, or validated explicit workspace recovery. clearSession and an
// ordinary unauthenticated refresh deliberately never call it: they are
// terminal aftermath, not proof of a new explicit session.
export const unblockAmbientRefresh = (): void => {
  readLocalStorage()?.removeItem(AMBIENT_REFRESH_BLOCKED_KEY)
}
