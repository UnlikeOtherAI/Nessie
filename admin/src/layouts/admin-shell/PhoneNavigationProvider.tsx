import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import {
  createPhoneHistoryLedger,
  currentPhoneHistoryEntry,
  recordPhoneHistory,
  resolvePhoneLedgerBackAction,
  resolvePhoneTabPress,
  resolvePhoneTabSelect,
  pathnameOf,
  type PhoneHistoryLedger,
  type PhoneTabAction,
} from './phone-navigation-ledger'
import {
  getPhoneNavigationBackTarget,
  type PhoneNavigationBackAction,
} from './phone-navigation'
import { NativePhoneNavigationBridge } from './NativePhoneNavigationBridge'
import { useLocalBackSnapshot } from './local-back/LocalBackContext'

export type PhoneNavigationApi = {
  // Run the route-level Back for the CURRENT location: ledger-aware
  // (resolveBackAction) then execute. This is the stable seam the on-screen
  // Back doorway, the native hardware-Back bridge, and the later interactive
  // gesture all consume, so they can never disagree about pop vs replace.
  performBack: () => void
  // Execute a resolved action (pop real history, or replace a cold deep link
  // with its deterministic parent).
  performBackAction: (action: Exclude<PhoneNavigationBackAction, null>) => void
  // Reselect the active tab: no-op at its root, pop/replace home from a detail.
  pressActiveTab: () => void
  // The Back action for a pathname — ledger-aware for the current location,
  // metadata-only otherwise.
  resolveBackAction: (pathname: string) => PhoneNavigationBackAction
  // Tap any tab: reselect semantics for the active one, root navigation for
  // the others.
  selectTab: (tabRoot: string) => void
}

const PhoneNavigationContext = createContext<PhoneNavigationApi | null>(null)

// Exactly one of these wraps the authenticated shell, mounted persistently so
// its ledger survives every route change. The shared Back control, the web
// tab bar, the native tab bridge, and Android hardware Back all consume this
// one context — a second hook-local ledger would let the surfaces disagree
// about when to pop versus re-anchor.
export const PhoneNavigationProvider = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const localBack = useLocalBackSnapshot()?.active ?? null
  const ledgerRef = useRef<PhoneHistoryLedger | null>(null)
  if (ledgerRef.current === null) {
    ledgerRef.current = createPhoneHistoryLedger(
      location.key,
      `${location.pathname}${location.search}${location.hash}`,
    )
  }

  // Record in a layout effect (never mutate refs during render): every commit
  // folds its location into the ledger before paint, so an action dispatched
  // from an event after commit — the Back doorway, a tab tap, Android
  // hardware Back — always reads the current location. The reducer is
  // idempotent, so a StrictMode double-effect or a re-render for the same
  // location records nothing twice.
  useLayoutEffect(() => {
    ledgerRef.current = recordPhoneHistory(
      ledgerRef.current ?? createPhoneHistoryLedger(
        location.key,
        `${location.pathname}${location.search}${location.hash}`,
      ),
      navigationType,
      location.key,
      `${location.pathname}${location.search}${location.hash}`,
    )
  })

  // Stable outward API: the ledger and the latest navigate/location live on
  // refs, so consumers and the native bridge never resubscribe per location
  // while their actions still see the post-commit state.
  const stateRef = useRef({ localBack, location, navigate })
  useLayoutEffect(() => {
    stateRef.current = { localBack, location, navigate }
  }, [localBack, location, navigate])

  const value = useMemo<PhoneNavigationApi>(() => {
    const currentLedger = (): PhoneHistoryLedger => {
      const current = stateRef.current.location
      return ledgerRef.current ?? createPhoneHistoryLedger(
        current.key,
        `${current.pathname}${current.search}${current.hash}`,
      )
    }
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
    const performBackAction = (action: Exclude<PhoneNavigationBackAction, null>): void => {
      const { navigate: nav } = stateRef.current
      if (action.mode === 'pop') {
        void nav(-1)
      } else {
        void nav(action.to, { replace: true })
      }
    }
    const resolveBackAction = (pathname: string): PhoneNavigationBackAction => {
      const ledger = currentLedger()
      if (pathname === pathnameOf(currentPhoneHistoryEntry(ledger)?.path ?? '')) {
        return resolvePhoneLedgerBackAction(ledger)
      }
      const target = getPhoneNavigationBackTarget(pathname)
      return target ? { mode: 'replace', to: target.pathname } : null
    }
    return {
      performBack: () => {
        const activeLocalBack = stateRef.current.localBack
        if (activeLocalBack) {
          activeLocalBack.onBack()
          return
        }
        const action = resolveBackAction(stateRef.current.location.pathname)
        if (action) performBackAction(action)
      },
      performBackAction,
      pressActiveTab: () => apply(resolvePhoneTabPress(currentLedger())),
      resolveBackAction,
      selectTab: (tabRoot) => apply(resolvePhoneTabSelect(currentLedger(), tabRoot)),
    }
  }, [])

  return (
    <PhoneNavigationContext.Provider value={value}>
      {children}
      <NativePhoneNavigationBridge />
    </PhoneNavigationContext.Provider>
  )
}

// Every phone navigation consumer shares this context. It is only null outside
// the authenticated shell (login/bootstrap), where phone navigation chrome is
// never rendered.
export const usePhoneNavigation = (): PhoneNavigationApi | null =>
  useContext(PhoneNavigationContext)
