import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import {
  createPhoneHistoryLedger,
  recordPhoneHistory,
  resolvePhoneTabPress,
  resolvePhoneTabSelect,
  type PhoneHistoryLedger,
  type PhoneTabAction,
} from './phone-navigation-ledger'
import { getPhoneTabRootPath } from './phone-navigation'
import type { NavSectionId } from './nav-items'
import { NativePhoneNavigationBridge } from './NativePhoneNavigationBridge'
import { useLocalBackSnapshot } from './local-back/LocalBackContext'
import { useNativeLargePhoneLandscapeApp } from '../../lib/mobile-shell'
import { resolveBack, type BackAction } from '../../navigation/back'
import { ANNOUNCER_ATTRIBUTE } from '../../navigation/settle'
import { canGoBack, canGoForward, resolveSectionTarget } from '../../navigation/history'
import {
  deferredRedirect,
  useTrackLocationKey,
  type RedirectOptions,
  type RedirectTarget,
} from '../../navigation/redirect'

export type BackOptions = {
  // An explicit return address wins over history: it is the one case where
  // the caller knows more than the ledger (a designer opened from a specific
  // row). Otherwise a real previous entry is popped, else `fallback` replaces.
  returnTo?: string | null
  returnToState?: unknown
  fallback: string
}

export type NavigationHistory = {
  canBack: boolean
  canForward: boolean
  // History controls (the desktop top bar, the iPad toolbar) walk the ledger
  // across sections — which Back never does — but consult the Back registry
  // first, so a toolbar Back over an open owner closes the owner.
  goBack: () => void
  goForward: () => void
}

export type PhoneNavigationApi = {
  // Run Back for the current location through the one resolver.
  performBack: () => void
  performBackAction: (action: BackAction) => void
  // The one Back decision, for the current location (ledger-aware) or for a
  // named pathname (metadata only).
  resolveBackAction: (pathname?: string) => BackAction | null
  hasBack: () => boolean
  // The shared smart Back for screens opened with a return address.
  back: (options: BackOptions) => void
  // A navigation the person did not ask for: replaces, forwards state, waits
  // for the stack to settle, and is dropped if the location moved on.
  redirect: (to: RedirectTarget, options?: RedirectOptions) => void
  history: NavigationHistory
  // Where a section's rail tab goes: the last place visited there this
  // session, else the section root.
  sectionTarget: (section: NavSectionId, root: string) => string
  // Reselect the active tab: no-op at its root, pop/replace home from a detail.
  pressActiveTab: () => void
  // Tap any tab: reselect semantics for the active one, root navigation for
  // the others.
  selectTab: (tabRoot: string) => void
}

const PhoneNavigationContext = createContext<PhoneNavigationApi | null>(null)

const fullPath = (location: { pathname: string; search: string; hash: string }): string =>
  `${location.pathname}${location.search}${location.hash}`

// The navigation controller. Exactly one wraps the authenticated shell, so
// its ledger survives every route change. The Back doorway, the edge swipe,
// Android hardware Back, the web tab bar, the desktop top bar, the iPad
// toolbar and the rail all consume this one context — a second hook-local
// ledger or counter would let the surfaces disagree.
export const PhoneNavigationProvider = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const localBack = useLocalBackSnapshot()
  const nativeLargePhoneLandscape = useNativeLargePhoneLandscapeApp()
  useTrackLocationKey()

  const ledgerRef = useRef<PhoneHistoryLedger | null>(null)
  if (ledgerRef.current === null) {
    ledgerRef.current = createPhoneHistoryLedger(location.key, fullPath(location))
  }
  // A render-time mirror of the ledger so history reads (Back/Forward
  // enablement, section targets) re-render with it; the ref stays the source
  // for actions dispatched from events.
  const [ledger, setLedger] = useState<PhoneHistoryLedger>(ledgerRef.current)

  // Record in a layout effect (never mutate refs during render): every commit
  // folds its location into the ledger before paint, so an action dispatched
  // from an event after commit always reads the current location. The
  // reducer is idempotent, so a StrictMode double-effect records nothing twice.
  useLayoutEffect(() => {
    const next = recordPhoneHistory(
      ledgerRef.current ?? createPhoneHistoryLedger(location.key, fullPath(location)),
      navigationType,
      location.key,
      fullPath(location),
    )
    if (next !== ledgerRef.current) {
      ledgerRef.current = next
      setLedger(next)
    }
  })

  const stateRef = useRef({ localBack, location, navigate })
  useLayoutEffect(() => {
    stateRef.current = { localBack, location, navigate }
  }, [localBack, location, navigate])

  const redirect = useMemo(
    () => (to: RedirectTarget, options?: RedirectOptions) => {
      const { location: current, navigate: nav } = stateRef.current
      deferredRedirect(nav, current.key, () => stateRef.current.location.key, to, options)
    },
    [],
  )

  // Landscape has a menu and detail in adjacent columns. Once that extra
  // column disappears, showing the retained detail alone is a dead end: land
  // on the section's menu instead. The ref makes this a true rotation
  // transition, never a redirect for an ordinary portrait deep link.
  const wasNativeLargePhoneLandscape = useRef(nativeLargePhoneLandscape)
  useLayoutEffect(() => {
    const returnedToPortrait = wasNativeLargePhoneLandscape.current && !nativeLargePhoneLandscape
    wasNativeLargePhoneLandscape.current = nativeLargePhoneLandscape
    if (!returnedToPortrait) return

    const menuPath = getPhoneTabRootPath(location.pathname)
    if (location.pathname !== menuPath) redirect(menuPath)
  }, [location.pathname, nativeLargePhoneLandscape, redirect])

  const value = useMemo<PhoneNavigationApi>(() => {
    const currentLedger = (): PhoneHistoryLedger => ledgerRef.current ?? ledger
    const apply = (tabAction: PhoneTabAction): void => {
      const { navigate: nav } = stateRef.current
      if (tabAction.type === 'pop') {
        void nav(-1)
      } else if (tabAction.type === 'replace') {
        void nav(tabAction.root, { replace: true })
      } else if (tabAction.type === 'push') {
        void nav(tabAction.root)
      }
    }
    const resolveBackAction = (pathname?: string): BackAction | null => {
      const current = stateRef.current.location.pathname
      const target = pathname ?? current
      return resolveBack({
        pathname: target,
        owners: stateRef.current.localBack,
        ledger: target === current ? currentLedger() : null,
      })
    }
    const performBackAction = (action: BackAction): void => {
      const { navigate: nav } = stateRef.current
      if (action.kind === 'owner') {
        action.perform()
      } else if (action.mode === 'pop') {
        void nav(-1)
      } else {
        void nav(action.to, { replace: true })
      }
    }
    return {
      performBack: () => {
        const action = resolveBackAction()
        if (action) performBackAction(action)
      },
      performBackAction,
      resolveBackAction,
      hasBack: () => resolveBackAction() !== null,
      back: ({ returnTo, returnToState, fallback }) => {
        const { navigate: nav } = stateRef.current
        if (returnTo) {
          void nav(returnTo, { replace: true, state: returnToState })
        } else if (canGoBack(currentLedger())) {
          void nav(-1)
        } else {
          void nav(fallback, { replace: true })
        }
      },
      redirect,
      history: {
        canBack: canGoBack(ledger),
        canForward: canGoForward(ledger),
        goBack: () => {
          const owner = stateRef.current.localBack?.active ?? null
          if (owner) {
            owner.onBack()
            return
          }
          if (canGoBack(currentLedger())) void stateRef.current.navigate(-1)
        },
        goForward: () => {
          if (canGoForward(currentLedger())) void stateRef.current.navigate(1)
        },
      },
      sectionTarget: (section, root) => resolveSectionTarget(ledger, section, root),
      pressActiveTab: () => apply(resolvePhoneTabPress(currentLedger())),
      selectTab: (tabRoot) => apply(resolvePhoneTabSelect(currentLedger(), tabRoot)),
    }
  }, [ledger, redirect])

  return (
    <PhoneNavigationContext.Provider value={value}>
      {children}
      <NativePhoneNavigationBridge />
      {/* The one polite live region: the settled screen's heading, debounced
          (docs/navigation/overview.md §12). Overlays announce through their own
          dialog semantics instead. */}
      <div aria-live="polite" className="sr-only" role="status" {...{ [ANNOUNCER_ATTRIBUTE]: '' }} />
    </PhoneNavigationContext.Provider>
  )
}

// Every navigation consumer shares this context. It is only null outside the
// authenticated shell (login/bootstrap), where navigation chrome is never
// rendered.
export const usePhoneNavigation = (): PhoneNavigationApi | null =>
  useContext(PhoneNavigationContext)
