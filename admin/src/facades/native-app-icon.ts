import { useEffect, useState } from 'react'

import { NATIVE_SHELL_INFO_EVENT } from '../lib/native-shell'

/**
 * The phone's Home Screen icon, chosen from Appearance settings.
 *
 * Only the iOS shell can change it, and only a build carrying the
 * `nessie-app-icon` module, so the control is offered when the shell says so
 * rather than whenever the page is inside a WebView. The shell answers with the
 * icon actually in effect, which is what the control shows.
 */

export type AppIconVariant = 'light' | 'dark'

export const NATIVE_APP_ICON_EVENT = 'nessie:native-app-icon'

type NativeAppIconWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieNativeShell?: { appIcon?: boolean }
  __nessieNativeAppIcon?: unknown
}

const readWindow = (): NativeAppIconWindow | null =>
  typeof window === 'undefined' ? null : (window as NativeAppIconWindow)

export const isNativeAppIconShell = (): boolean => {
  const shell = readWindow()
  return !!shell && 'ReactNativeWebView' in shell && shell.__nessieNativeShell?.appIcon === true
}

export const readNativeAppIcon = (): AppIconVariant =>
  readWindow()?.__nessieNativeAppIcon === 'light' ? 'light' : 'dark'

export const requestNativeAppIcon = (icon: AppIconVariant): void => {
  readWindow()?.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'nessie:app-icon', icon }))
}

/** Whether the choice is available here, and the icon currently in effect. */
export const useNativeAppIcon = (): { available: boolean; icon: AppIconVariant } => {
  const [state, setState] = useState(() => ({
    available: isNativeAppIconShell(),
    icon: readNativeAppIcon(),
  }))

  useEffect(() => {
    // The shell publishes its capabilities after the page loads and again on
    // rotation, so both facts are re-read on either event.
    const sync = (): void => setState({ available: isNativeAppIconShell(), icon: readNativeAppIcon() })
    window.addEventListener(NATIVE_SHELL_INFO_EVENT, sync)
    window.addEventListener(NATIVE_APP_ICON_EVENT, sync)
    sync()
    return () => {
      window.removeEventListener(NATIVE_SHELL_INFO_EVENT, sync)
      window.removeEventListener(NATIVE_APP_ICON_EVENT, sync)
    }
  }, [])

  return state
}
