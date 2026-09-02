import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useLocalBack } from '../layouts/admin-shell/local-back/LocalBackContext'

// A nested stage is how a state-driven screen joins the navigation stack: a
// column browser's next column, a Knowledge folder → document → history →
// editor, a dashboard's add-widget panel. On a single-column layout the
// stack hosts it as a real layer — it slides in and out like a route, Back
// unwinds it, the edge swipe can drive it — and the page keeps rendering it
// through a portal, so context and state never leave the page. Where no
// stack hosts stages (a split layout, a test without a viewport) the stage
// renders inline, where it stands, and the page composes it.
//
// Keep a stage mounted and toggle `active`; an unmount leaves without
// motion. Rulebook: docs/navigation.md §6.

export type NestedStageHost = {
  activate: (id: string, container: HTMLElement) => void
  deactivate: (id: string, options: { animate: boolean }) => void
  // Ids currently in the stack — changes with every commit, so a stage whose
  // entry was released under it (a sibling swap, a route change) re-asserts
  // itself instead of rendering into a container nothing shows.
  stageIds: readonly string[]
}

export const NestedStageHostContext = createContext<NestedStageHost | null>(null)

// Whether a stack hosts stages here. A page that must compose differently in
// the two cases asks the host, never a breakpoint: Knowledge keeps the space's
// root listing rendered beneath an open folder stage on a single-column
// layout, and composes one pane at a time where the stages render inline.
export const useNestedStageHosted = (): boolean =>
  useContext(NestedStageHostContext) !== null

export type NestedStageProps = {
  active: boolean
  children: ReactNode
  id: string
  // The Back control's label while this stage is on top.
  label: string
  onBack: () => void
  // Back precedence among simultaneously active stages: the deeper stage
  // registers the higher number.
  priority: number
  // Whether the edge swipe may close it. An editor mid-flush says false.
  swipeable?: boolean
}

const createContainer = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null
  const container = document.createElement('div')
  container.className = 'phone-navigation-page'
  container.setAttribute('data-phone-navigation-page', '')
  return container
}

export const NestedStage = ({
  active,
  children,
  id,
  label,
  onBack,
  priority,
  swipeable,
}: NestedStageProps) => {
  const host = useContext(NestedStageHostContext)
  const [container] = useState(createContainer)
  const hosted = host !== null && container !== null

  useLocalBack({
    active: active && hosted,
    id: `stage:${id}`,
    label,
    onBack,
    priority,
    swipeable,
  })

  // A retained page instance and a fresh one for the same route (a push
  // over an open stage mounts the page again) both render this stage under
  // one id; only the instance that pushed the entry may pop it, or the
  // second instance's unmount would close the first one's open stage.
  const owns = useRef(false)
  useLayoutEffect(() => {
    if (!host || !container) return
    if (active) {
      if (!host.stageIds.includes(id)) {
        host.activate(id, container)
        owns.current = true
      }
    } else if (owns.current && host.stageIds.includes(id)) {
      host.deactivate(id, { animate: true })
      owns.current = false
    }
  }, [active, container, host, id])

  // The host value changes with every stack commit (its stageIds do), so the
  // unmount leave reads the latest host through a ref rather than
  // re-running — a cleanup on every commit would pop the stage it just
  // pushed.
  const hostRef = useRef(host)
  hostRef.current = host
  useLayoutEffect(() => () => {
    if (owns.current) hostRef.current?.deactivate(id, { animate: false })
  }, [id])

  if (!active) return null
  return hosted ? createPortal(children, container) : <>{children}</>
}
