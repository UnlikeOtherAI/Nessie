/**
 * The native shell's own globals: is this page inside the React Native
 * WebView, and what did that shell tell us about itself.
 *
 * Pure reads of `window`, deliberately free of React and of the navigation
 * layout, because the transport modules (`session-client`, `haptics`,
 * `open-external-url`, `reload-shortcut`, `disable-zoom`, `external-auth`) ask
 * the same question and must not depend on a layout hook to do it. The hooks
 * that turn these facts into a layout live in `navigation/mobile-shell.ts`.
 */

export type NativeShellInfo = {
  platform?: string
  formFactor?: 'ipad' | 'phone' | string
}

type NativeShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieNativeShell?: NativeShellInfo
  __nessiePendingPushPath?: unknown
}

export const NATIVE_SHELL_INFO_EVENT = 'nessie:native-shell-info'

// True inside the React Native WebView shell (the mobile app). The shell injects
// a `ReactNativeWebView` global that backs the postMessage bridge. Mirrors the
// desktop `isDesktopApp()` check in ./desktop.ts.
export const isReactNativeWebView = (): boolean =>
  typeof window !== 'undefined' && 'ReactNativeWebView' in window

// A full refresh belongs to the native frame: it remounts the WebView with a
// cache-busting URL instead of asking the hosted page to reload itself.
export const requestNativeFullRefresh = (): void => {
  if (!isReactNativeWebView()) return
  ;(window as NativeShellWindow).ReactNativeWebView?.postMessage(
    JSON.stringify({ type: 'nessie:full-refresh' }),
  )
}

// The native shell writes a tapped notification target before the SPA exists,
// then emits an event. Reading the retained path closes the startup race where
// the event arrives before React has subscribed.
export const readNativePendingPushPath = (): string | null => {
  if (typeof window === 'undefined') return null
  const path = (window as NativeShellWindow).__nessiePendingPushPath
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

export const readNativeShellInfo = (): NativeShellInfo | null => {
  if (typeof window === 'undefined') return null
  return (window as NativeShellWindow).__nessieNativeShell ?? null
}

