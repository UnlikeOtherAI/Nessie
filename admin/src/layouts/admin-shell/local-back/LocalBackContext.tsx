import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  createLocalBackRegistry,
  type LocalBackRegistry,
  type LocalBackRegistration,
  type LocalBackSnapshot,
} from './local-back-registry'

const LocalBackRegistryContext = createContext<LocalBackRegistry | null>(null)

// One persistent registry for the whole authenticated shell. Phone surfaces
// register their in-page Back actions here; the shell's leading doorway
// (PhoneNavigationButton) reads the active action and yields to it. The
// provider owns the store's lifetime so registrations from any page —
// including pages the phone transition retains during a swipe — stay coherent.
export const LocalBackProvider = ({ children }: { children: ReactNode }) => {
  const registry = useMemo(() => createLocalBackRegistry(), [])
  return (
    <LocalBackRegistryContext.Provider value={registry}>
      {children}
    </LocalBackRegistryContext.Provider>
  )
}

const useLocalBackRegistry = (): LocalBackRegistry | null =>
  useContext(LocalBackRegistryContext)

const emptySubscribe = () => () => undefined

// The registry's live snapshot, or null outside the shell (tests, isolated
// stories). `active` is what the shell doorway and any native/gesture bridge
// consume to hand Back ownership to the deepest in-page stack.
export const useLocalBackSnapshot = (): LocalBackSnapshot | null => {
  const registry = useLocalBackRegistry()
  return useSyncExternalStore(
    registry?.subscribe ?? emptySubscribe,
    registry ? registry.getSnapshot : () => null,
  )
}

export type UseLocalBackOptions = Omit<LocalBackRegistration, 'onBack'> & {
  onBack: () => void
}

// Registers one in-page Back action. Renders nothing — the caller keeps its
// own header title/actions on wider layouts and simply suppresses its own
// phone doorway while the shell renders the shared one. `active` is explicit:
// retained-but-hidden phone columns must pass `active: false` rather than
// relying on unmount order. The action is held in a callback ref so a fresh
// closure every render never re-registers; the layout effect commits
// id/label/active/priority changes before paint so the doorway can never show
// a stale owner for a frame.
export const useLocalBack = (options: UseLocalBackOptions): void => {
  const registry = useLocalBackRegistry()
  const { active, id, label, priority } = options
  // Stable ref indirection: the registry stores this one wrapper and always
  // dispatches to the caller's latest closure.
  const actionRef = useRef(options.onBack)
  actionRef.current = options.onBack
  const onBack = useCallback(() => actionRef.current(), [])

  useLayoutEffect(() => {
    if (!registry) return undefined
    return registry.register({ active, id, label, onBack, priority })
  }, [active, id, label, onBack, priority, registry])
}

// Explicit numeric precedence for the shell doorway. The deepest in-page
// stack registers the highest number; hidden-but-retained owners deactivate
// rather than compete, so ties never decide ownership. Column-browser
// columns derive their precedence from their depth via columnBackPriority.
export const LOCAL_BACK_PRIORITY = {
  knowledgeFolder: 11,
  knowledgeDocument: 12,
  knowledgeHistory: 13,
  knowledgeEditor: 14,
  columnBase: 20,
  columnStep: 2,
  executorsCreate: 30,
  dashboardPanel: 30,
  dashboardVersions: 31,
} as const

export const columnBackPriority = (columnIndex: number): number =>
  LOCAL_BACK_PRIORITY.columnBase + columnIndex * LOCAL_BACK_PRIORITY.columnStep

type ColumnBackContextValue = {
  // The index this column occupies in its ColumnBrowserViewport, or null when
  // the column renders outside a viewport (desktop drawers and dialogs).
  index: number | null
  // True while this column is the one a phone viewport is actually showing.
  // A phone keeps every column mounted (the slide transition needs the row),
  // so a retained off-screen column must never hold the Back doorway — it
  // keeps its registration but with active: false.
  phoneVisible: boolean
}

const ColumnBackContext = createContext<ColumnBackContextValue>({
  index: null,
  phoneVisible: false,
})

export const ColumnBackProvider = ({
  children,
  value,
}: {
  children: ReactNode
  value: ColumnBackContextValue
}) => (
  <ColumnBackContext.Provider value={value}>{children}</ColumnBackContext.Provider>
)

export const useColumnBackContext = (): ColumnBackContextValue =>
  useContext(ColumnBackContext)
