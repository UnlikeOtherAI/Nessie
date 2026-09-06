import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { isReactNativeWebView } from '../../lib/native-shell'
import { useNativeIOSPhoneApp, usePhoneLayout } from '../../navigation/mobile-shell'
import {
  onScreenTransition,
  sameScreenBar,
  useCurrentScreenBar,
  type ScreenBar,
} from '../../navigation/screen-bar'
import {
  applyScreen,
  describeScreen,
  sameScreen,
  useScreenTitle,
  type ScreenMessage,
} from '../../navigation/screen'
import { usePhoneNavigation } from './PhoneNavigationProvider'
import { useLocalBackSnapshot } from '../../navigation/LocalBackContext'

type NativePhoneWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieNativeBack?: () => void
  __nessieScreenBarAction?: (id: string, itemId?: string) => void
  __nessieScreenBarBack?: () => void
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
  // The native navigation bar is an iOS-shell surface. Mobile Safari, Android
  // and iPad keep the header the web draws, so nothing below this line may
  // change what they render.
  const nativeIOSPhone = useNativeIOSPhoneApp() && phoneLayout
  const { bar, layerKey } = useCurrentScreenBar()
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
  // screen in its own chrome (docs/navigation/overview.md §9/§10, plan §4.16).
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

  // `nessie:screen-bar` — what the native navigation bar shows for the layer
  // the reader is standing on. Keyed by layer rather than pathname because a
  // nested stage never changes the pathname and two screens can share one
  // route (screen-bar.ts). Posted only when something visible changed: the
  // handlers inside the descriptor are rebuilt every render and are compared
  // out by `sameScreenBar`.
  const postedBar = useRef<{ bar: ScreenBar | null, layerKey: string | null } | null>(null)
  useEffect(() => {
    if (!nativeIOSPhone) return
    const posted = postedBar.current
    if (posted && posted.layerKey === layerKey && sameScreenBar(posted.bar, bar)) return
    postedBar.current = { bar, layerKey }
    ;(window as NativePhoneWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({
        type: 'nessie:screen-bar',
        layerKey,
        title: bar?.title ?? '',
        back: bar?.back ? { label: bar.back.label } : null,
        // Everything that decides what an action looks like; what it *does*
        // stays behind `__nessieScreenBarAction`, because three of the four
        // kinds do not simply call an `onSelect` (screen-bar-actions.ts).
        actions: (bar?.actions ?? []).map((action) => ({
          checked: action.checked,
          disabled: action.disabled,
          id: action.id,
          items: action.items,
          kind: action.kind,
          label: action.label,
          primary: action.primary,
          priority: action.priority,
          selected: action.selected,
          tone: action.tone,
        })),
      }),
    )
  }, [bar, layerKey, nativeIOSPhone])

  // `nessie:screen-transition` — the bar runs the stack's motion beside it.
  // Announced from the viewport's layout effect as the transition starts,
  // which is *before* the incoming layer has mounted and published anything:
  // the native side fills that lane when the descriptor arrives rather than
  // restarting the animation.
  useEffect(() => {
    if (!nativeIOSPhone) return undefined
    return onScreenTransition((transition) => {
      ;(window as NativePhoneWindow).ReactNativeWebView?.postMessage(
        JSON.stringify({ type: 'nessie:screen-transition', ...transition }),
      )
    })
  }, [nativeIOSPhone])

  // The bar's Back is the header's own, not the resolver's, so the native
  // chevron runs the handler the live descriptor carries rather than
  // `performBack()` — a Flow that owns its Back returns somewhere the registry
  // cannot name.
  const barRef = useRef<ScreenBar | null>(bar)
  barRef.current = bar
  useEffect(() => {
    const target = window as NativePhoneWindow
    target.__nessieScreenBarBack = () => barRef.current?.back?.onBack()
    target.__nessieScreenBarAction = (id: string, itemId?: string) => {
      const action = barRef.current?.actions.find((candidate) => candidate.id === id)
      if (!action || action.disabled) return
      action.perform(itemId)
    }
    return () => {
      delete target.__nessieScreenBarAction
      delete target.__nessieScreenBarBack
    }
  }, [])

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
