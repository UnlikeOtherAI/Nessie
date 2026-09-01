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
  return '__TAURI_INTERNALS__' in tauriWindow || '__TAURI__' in tauriWindow
}

/** The desktop shell's own platform, or null in a browser / the mobile WebView. */
export const readDesktopPlatform = (): DesktopPlatform | null => {
  if (typeof window === 'undefined') return null
  const published = (window as TauriWindow).__nessieDesktopPlatform
  return DESKTOP_PLATFORMS.find((platform) => platform === published) ?? null
}
