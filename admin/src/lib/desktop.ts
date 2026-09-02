type TauriWindow = Window & {
  __TAURI__?: unknown
  __TAURI_INTERNALS__?: unknown
}

export const isDesktopApp = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  const tauriWindow = window as TauriWindow
  return '__TAURI_INTERNALS__' in tauriWindow || '__TAURI__' in tauriWindow
}

type DesktopPendingWindow = Window & { __nessieDesktopPendingPath?: unknown }

// The Tauri init script retains a clicked notification's route on the
// window before dispatching its open event, because a click that launched a
// quit app fires before the SPA has subscribed. Reading consumes it, so the
// root redirect replays it once and a later cold start does not repeat it
// (docs/navigation/overview.md §8).
export const consumeDesktopPendingPath = (): string | null => {
  if (typeof window === 'undefined') return null
  const target = window as DesktopPendingWindow
  const path = target.__nessieDesktopPendingPath
  delete target.__nessieDesktopPendingPath
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null
}
