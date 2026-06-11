import { useMediaQuery } from '../hooks/useMediaQuery'

// True inside the React Native WebView shell (the mobile app). The shell injects
// a `ReactNativeWebView` global that backs the postMessage bridge. Mirrors the
// desktop `isDesktopApp()` check in ./desktop.ts.
export const isReactNativeWebView = (): boolean =>
  typeof window !== 'undefined' && 'ReactNativeWebView' in window

// Tailwind's `md` breakpoint is 768px; the secondary sidebars are `hidden md:flex`,
// so below it we treat the layout as mobile and drive navigation from a bottom tab
// bar + hamburger drawer instead of the rail + secondary sidebar.
const MOBILE_MAX_WIDTH_QUERY = '(max-width: 767px)'

// True when the UI should use the mobile layout: either a narrow viewport (mobile
// web) or the native mobile shell (which is always mobile-laid-out regardless of
// the reported viewport — e.g. iPad).
export const useMobileLayout = (): boolean => {
  const narrow = useMediaQuery(MOBILE_MAX_WIDTH_QUERY)
  return narrow || isReactNativeWebView()
}
