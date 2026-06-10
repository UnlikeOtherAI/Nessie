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
