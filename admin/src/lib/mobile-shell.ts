import { useEffect, useState } from 'react'
import { registerViewportMediaQuery, useViewport } from '../hooks/useViewport'

type NativeShellInfo = {
  platform?: string
  formFactor?: 'ipad' | 'phone' | string
}

type NativeShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieNativeShell?: NativeShellInfo
  __nessiePendingPushPath?: unknown
}

const NATIVE_SHELL_INFO_EVENT = 'nessie:native-shell-info'

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

// A Max-class iPhone gets the tablet-style adjacent navigation only while it
// is actually in landscape. It remains a phone native shell, including its
// bottom tab bar and Search destination, rather than becoming an iPad shell.
export const useNativeLargePhoneLandscapeApp = (): boolean => {
  const info = useNativeShellInfo()
  return isReactNativeWebView()
    && info?.platform === 'ios'
    && info.formFactor === 'large-phone-landscape'
}

// A phone WebView uses native home controls on both iOS and Android. Keep this
// form-factor distinction here rather than scattering shell checks through page
// components.
export const useNativePhoneApp = (): boolean => {
  const info = useNativeShellInfo()
  return isReactNativeWebView()
    && (info?.formFactor === 'phone' || info?.formFactor === 'large-phone-landscape')
}

// iOS-only controls (such as its glass conversation Back affordance) still
// need to distinguish an iPhone from an Android handset.
export const useNativeIOSPhoneApp = (): boolean => {
  const info = useNativeShellInfo()
  return isReactNativeWebView()
    && info?.platform === 'ios'
    && (info.formFactor === 'phone' || info.formFactor === 'large-phone-landscape')
}

// Below Tailwind's `md` breakpoint (768px) we treat the layout as mobile and drive
// navigation from a tab bar + hamburger drawer instead of the rail + secondary
// sidebar (the layout decides which to render; the sidebars carry no responsive
// hiding of their own). "Narrow" is `!atLeast.md` from the viewport store — a
// minimum-query complement, so there is no 767/768 fractional gap (plan §B).

// A tablet-sized viewport: both dimensions are large enough to keep the secondary
// sidebar pinned. The explicit Max-iPhone landscape shell is the only exception:
// its native frame names the form factor, so ordinary phones still cannot become
// multi-column merely by rotating. An iPad in a narrow Split View correctly drops
// below this query and gets the drawer. This is a two-dimensional device-physics
// fact the band scale cannot express, so it lives as a named one-off lane on the
// viewport store.
const TABLET_MIN_QUERY = '(min-width: 600px) and (min-height: 600px)'
registerViewportMediaQuery('tabletMin', TABLET_MIN_QUERY)

// True when the UI should use the mobile layout: either a narrow viewport (mobile
// web) or the native mobile shell (which is always mobile-laid-out regardless of
// the reported viewport — e.g. iPad).
export const useMobileLayout = (): boolean => {
  const narrow = !useViewport().atLeast.md
  return narrow || isReactNativeWebView()
}

// True on a tablet (e.g. iPad) running the native shell: the native tab bar replaces
// the rail, but the screen is wide enough to keep the secondary sidebar pinned open
// rather than behind a hamburger drawer.
export const useTabletShell = (): boolean => {
  const tablet = useViewport().media?.tabletMin ?? false
  const largePhoneLandscape = useNativeLargePhoneLandscapeApp()
  return isReactNativeWebView() && (tablet || largePhoneLandscape)
}

// Phone layout: the narrow hamburger-drawer experience. Tablets keep the sidebar
// pinned, so they are explicitly excluded even though they are "mobile".
//
// Both hooks must be called unconditionally: a `useMobileLayout() && !useTabletShell()`
// one-liner short-circuits the `useTabletShell()` hook whenever the viewport is wide,
// so crossing the md breakpoint between renders changes the hook count
// and throws React error #310 ("Rendered more hooks than during the previous render").
export const usePhoneLayout = (): boolean => {
  const mobile = useMobileLayout()
  const tablet = useTabletShell()
  return mobile && !tablet
}
