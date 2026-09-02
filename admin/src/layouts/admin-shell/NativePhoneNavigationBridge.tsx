import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import {
  applyScreen,
  describeScreen,
  sameScreen,
  useScreenTitle,
  type ScreenMessage,
} from '../../navigation/screen'
import { usePhoneNavigation } from './PhoneNavigationProvider'
import { useLocalBackSnapshot } from './local-back/LocalBackContext'

type NativePhoneWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieNativeBack?: () => void
  __nessieSelectTab?: (path: string) => void
}

// The admin-owned seam between the shared phone navigation ledger and the
// native shell. It reports back-state per route only while the phone layout
// owns the chrome (a tablet keeps its own toolbar and hardware-Back default),
// and it exposes the two native entry points — hardware Back and native tab
// taps — onto the same decisions the on-screen controls make. The generic
// NativeShellBridge keeps owning the plain navigate/transport/theme plumbing;
// this bridge deliberately touches nothing but phone navigation.
export const NativePhoneNavigationBridge = () => {
  const location = useLocation()
  const navigation = usePhoneNavigation()
  const localBack = useLocalBackSnapshot()?.active ?? null
  const phoneLayout = usePhoneLayout()
  const nativePhone = isReactNativeWebView() && phoneLayout
  // The resolver's answer for the current location: an owner, a route
  // parent, or nothing. Re-read whenever the route or the registry changes.
  const hasBack = navigation?.hasBack() ?? false
  // The title the screen's own header published for this exact route.
  const screenTitle = useScreenTitle(location.pathname)

  // Post the LATEST consumable back state for the current route. Posts are
  // not gated on the native phone layout: the mobile shell decides
  // consumption (Android phones only) and needs fresh state at every route —
  // including on the tablet layout, where a stale `true` would otherwise
  // linger after the layout flips.
  useEffect(() => {
    if (!isReactNativeWebView()) return
    ;(window as NativePhoneWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        type: 'nessie:back-state',
        hasBackDepth: nativePhone && hasBack,
      }),
    )
  }, [hasBack, localBack, nativePhone, location.pathname])

  // `nessie:screen` — what screen the person is on, so the shell stops
  // re-deriving the tab from a hand-copied prefix list and can name the
  // screen in its own chrome (docs/navigation.md §9/§10, plan §4.16).
  // `section`, `screenType` and `depth` come off the surface registry,
  // `hasBack` off the one Back resolver, and `title` off the rendered header.
  // Posted on every settled change of any field, never on a re-render that
  // changes none. `nessie:route` and `nessie:back-state` are unchanged.
  const screen = describeScreen(location.pathname, screenTitle, hasBack)
  const postedScreen = useRef<ScreenMessage | null>(null)
  useEffect(() => {
    if (sameScreen(postedScreen.current, screen)) return
    postedScreen.current = screen
    applyScreen(screen, isReactNativeWebView()
      ? (payload) => (window as NativePhoneWindow).ReactNativeWebView?.postMessage(payload)
      : null)
  }, [screen])

  // The native entry points are always present while the provider is mounted:
  // hardware Back runs the one shared performBack seam (the later local-Back
  // and interactive-gesture consumers plug into the same function), and a
  // native tab tap selects through the shared ledger.
  useEffect(() => {
    const target = window as NativePhoneWindow
    target.__nessieNativeBack = () => navigation?.performBack()
    target.__nessieSelectTab = (path: string) => {
      if (typeof path === 'string' && path.startsWith('/')) {
        navigation?.selectTab(path)
      }
    }
    return () => {
      delete target.__nessieNativeBack
      delete target.__nessieSelectTab
    }
  }, [navigation])

  return null
}
