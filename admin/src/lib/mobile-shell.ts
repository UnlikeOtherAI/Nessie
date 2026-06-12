import { useMediaQuery } from '../hooks/useMediaQuery'

// True inside the React Native WebView shell (the mobile app). The shell injects
// a `ReactNativeWebView` global that backs the postMessage bridge. Mirrors the
// desktop `isDesktopApp()` check in ./desktop.ts.
export const isReactNativeWebView = (): boolean =>
  typeof window !== 'undefined' && 'ReactNativeWebView' in window

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
export const usePhoneLayout = (): boolean => useMobileLayout() && !useTabletShell()
