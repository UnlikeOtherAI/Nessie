import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import { phoneRouteHasBackDepth } from './phone-navigation'
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
        hasBackDepth: nativePhone && Boolean(
          localBack || phoneRouteHasBackDepth(location.pathname),
        ),
      }),
    )
  }, [localBack, nativePhone, location.pathname])

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
