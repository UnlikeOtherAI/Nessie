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

export const isAmbientRefreshBlocked = (): boolean => {
  try {
    return readLocalStorage()?.getItem(AMBIENT_REFRESH_BLOCKED_KEY) === BLOCKED_VALUE
  } catch {
    return false
  }
}

// Synchronous by design: the coordinator's onTerminalStart hook calls this
// at the exact moment a logout or foreign fence begins — before any awaited
// DELETE/revocation — so a remount mid-finalization already reads the fence.
export const blockAmbientRefresh = (): void => {
  try {
    readLocalStorage()?.setItem(AMBIENT_REFRESH_BLOCKED_KEY, BLOCKED_VALUE)
  } catch {
    // The in-memory host gate remains authoritative for this mount.
  }
}

// Called only after a successfully APPLIED explicit login, bootstrap,
// dev login, or validated explicit workspace recovery. clearSession and an
// ordinary unauthenticated refresh deliberately never call it: they are
// terminal aftermath, not proof of a new explicit session.
export const unblockAmbientRefresh = (): void => {
  try {
    readLocalStorage()?.removeItem(AMBIENT_REFRESH_BLOCKED_KEY)
  } catch {
    // Explicit login still reopens the in-memory host gate.
  }
}
