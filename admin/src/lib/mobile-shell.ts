import { useEffect, useState } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'

type NativeShellInfo = {
  platform?: string
  formFactor?: 'ipad' | 'phone' | string
}

type NativeShellWindow = Window & {
  __nessieNativeShell?: NativeShellInfo
  __nessiePendingPushPath?: unknown
}

const NATIVE_SHELL_INFO_EVENT = 'nessie:native-shell-info'

// True inside the React Native WebView shell (the mobile app). The shell injects
// a `ReactNativeWebView` global that backs the postMessage bridge. Mirrors the
// desktop `isDesktopApp()` check in ./desktop.ts.
export const isReactNativeWebView = (): boolean =>
  typeof window !== 'undefined' && 'ReactNativeWebView' in window

// The native shell writes a tapped notification target before the SPA exists,
// then emits an event. Reading the retained path closes the startup race where
// the event arrives before React has subscribed.
export const readNativePendingPushPath = (): string | null => {
  if (typeof window === 'undefined') return null
  const path = (window as NativeShellWindow).__nessiePendingPushPath
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

const readNativeShellInfo = (): NativeShellInfo | null => {
  if (typeof window === 'undefined') return null
  return (window as NativeShellWindow).__nessieNativeShell ?? null
}

export const useNativeShellInfo = (): NativeShellInfo | null => {
  const [info, setInfo] = useState<NativeShellInfo | null>(() => readNativeShellInfo())

  useEffect(() => {
    const sync = () => setInfo(readNativeShellInfo())
    window.addEventListener(NATIVE_SHELL_INFO_EVENT, sync)
    sync()
    return () => window.removeEventListener(NATIVE_SHELL_INFO_EVENT, sync)
  }, [])

  return info
}

export const useNativeIPadApp = (): boolean => {
  const info = useNativeShellInfo()
  return isReactNativeWebView() && info?.platform === 'ios' && info.formFactor === 'ipad'
}

// Below Tailwind's `md` breakpoint (768px) we treat the layout as mobile and drive
// navigation from a tab bar + hamburger drawer instead of the rail + secondary
// sidebar (the layout decides which to render; the sidebars carry no responsive
// hiding of their own).
const MOBILE_MAX_WIDTH_QUERY = '(max-width: 767px)'

// A tablet-sized viewport: both dimensions are large enough to keep the secondary
// sidebar pinned. Phones never satisfy both at once (their short side is ≤ ~440px
// in any orientation), so this cleanly separates iPad from iPhone — and an iPad in
// a narrow Split View correctly drops below it and gets the drawer.
const TABLET_MIN_QUERY = '(min-width: 600px) and (min-height: 600px)'

// True when the UI should use the mobile layout: either a narrow viewport (mobile
// web) or the native mobile shell (which is always mobile-laid-out regardless of
// the reported viewport — e.g. iPad).
export const useMobileLayout = (): boolean => {
  const narrow = useMediaQuery(MOBILE_MAX_WIDTH_QUERY)
  return narrow || isReactNativeWebView()
}

// True on a tablet (e.g. iPad) running the native shell: the native tab bar replaces
// the rail, but the screen is wide enough to keep the secondary sidebar pinned open
// rather than behind a hamburger drawer.
export const useTabletShell = (): boolean => {
  const tablet = useMediaQuery(TABLET_MIN_QUERY)
  return isReactNativeWebView() && tablet
}

// Phone layout: the narrow hamburger-drawer experience. Tablets keep the sidebar
// pinned, so they are explicitly excluded even though they are "mobile".
//
// Both hooks must be called unconditionally: a `useMobileLayout() && !useTabletShell()`
// one-liner short-circuits the `useTabletShell()` hook whenever the viewport is wide,
// so crossing the (max-width: 767px) breakpoint between renders changes the hook count
// and throws React error #310 ("Rendered more hooks than during the previous render").
export const usePhoneLayout = (): boolean => {
  const mobile = useMobileLayout()
  const tablet = useTabletShell()
  return mobile && !tablet
}
