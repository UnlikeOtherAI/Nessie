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
  const getSnapshot = registry ? registry.getSnapshot : () => null
  // A server render has no registrations yet — nothing has mounted to make
  // one — so the server snapshot is the same read. Without it a static
  // render of any screen that composes the doorway throws.
  return useSyncExternalStore(
    registry?.subscribe ?? emptySubscribe,
    getSnapshot,
    getSnapshot,
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
// columns derive their precedence from their depth via columnBackPriority —
// a pushed column carries it onto the stage its viewport registers for it.
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

export type ColumnStageReport = {
  // The Back control's label while this column owns the doorway.
  label: string
  // Stable across the column's renders: the column holds its caller's fresh
  // closure in a ref, so a report never changes identity for a re-render.
  onBack: () => void
}

type ColumnBackContextValue = {
  // The index this column occupies in its ColumnBrowserViewport, or null when
  // the column renders outside a viewport (desktop drawers and dialogs).
  index: number | null
  // The one-way channel a column browser opens while it hosts its columns as
  // navigation-stack layers: only a column knows its own title and unwind
  // action, so it reports them up and the viewport owns the single
  // registration (the nested stage's for a pushed column; its own local-back
  // owner for column 0, which is the page rather than a layer). Null wherever
  // the columns are a plain track — a split layout, or a column outside any
  // viewport — where the column paints its own PhoneBackButton instead.
  reportBack: ((index: number, report: ColumnStageReport | null) => void) | null
}

const ColumnBackContext = createContext<ColumnBackContextValue>({
  index: null,
  reportBack: null,
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
