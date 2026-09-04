// The desktop platform is a structural fact published by the Tauri shell's init
// script (`window.__nessieDesktopPlatform`, from Rust `std::env::consts::OS`)
// before any admin code runs. Never derive it from the user agent — the WebView
// user agent is a rendering-engine string, not a statement about which shell is
// hosting the admin, and WebKitGTK reports the same thing on a Linux desktop as
// it does in a Linux browser tab.
export type DesktopPlatform = 'linux' | 'macos' | 'windows'

const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = ['linux', 'macos', 'windows']

type TauriWindow = Window & {
  __TAURI__?: unknown
  __TAURI_INTERNALS__?: unknown
  __nessieDesktopPlatform?: unknown
}

export const isDesktopApp = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  const tauriWindow = window as TauriWindow
  // Some Tauri WebViews deliberately omit the legacy global bridge even with
  // withGlobalTauri enabled. The shell's document-start platform marker is
  // equally native and keeps its custom title bar reachable in that case.
  return (
    '__TAURI_INTERNALS__' in tauriWindow ||
    '__TAURI__' in tauriWindow ||
    '__nessieDesktopPlatform' in tauriWindow
  )
}

// The Tauri shell records its target OS before the document loads. User-agent
// inference would make the hosted web app look native and duplicate macOS's
// own traffic lights, so native chrome is driven by that structural fact.
export const desktopPlatform = (): DesktopPlatform | null => {
  if (!isDesktopApp()) return null
  const platform = (window as TauriWindow).__nessieDesktopPlatform
  return platform === 'linux' || platform === 'macos' || platform === 'windows' ? platform : null
}

export const usesCustomDesktopWindowControls = (): boolean => {
  const platform = desktopPlatform()
  return platform === 'linux' || platform === 'windows'
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

/** The desktop shell's own platform, or null in a browser / the mobile WebView. */
export const readDesktopPlatform = (): DesktopPlatform | null => {
  if (typeof window === 'undefined') return null
  const published = (window as TauriWindow).__nessieDesktopPlatform
  return DESKTOP_PLATFORMS.find((platform) => platform === published) ?? null
}
