import type { ReactNode } from 'react'
import { useNativeBarHeader } from '../../../navigation/useNativeBarHeader'
import { useScreenBarLayer } from '../../../navigation/ScreenBarLayer'
import { toScreenBarActions } from '../../shared/screen-bar-actions'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../shared/ResponsivePageHeader'

type KnowledgePaneProps = {
  actions?: PageHeaderAction[]
  /**
   * A pane's own toolbar, rendered **inside** the header block rather than as a
   * second bordered bar under it (`ResponsivePageHeader`'s `below` slot: "one
   * bordered block, never a second header"). The spreadsheet pane is what
   * needs it — it already stacks IronCalc's own toolbar and formula bar above
   * the grid, and a third bordered row of ours read as chrome nobody chose.
   */
  below?: ReactNode
  children: ReactNode
  onBack?: () => void
  title: string
}

// Full-width chrome for the knowledge main area. Its actions use the shared
// responsive header so a project Docs tab can collapse into More without ever
// overlapping the title or an adjacent navigation column. A hosted stage owns
// its Back action even though `KnowledgeWorkspace` deliberately passes no
// `onBack`: native iOS publishes that action into its bar, while web and
// Android render the same action in this header. The route header underneath
// the stage is retained off-screen and cannot be the visible doorway.
export const KnowledgePane = ({ actions, below, children, onBack, title }: KnowledgePaneProps) => {
  // Only a pane that *is* an open stage publishes. The same component also
  // renders in a route layer — the space's root listing beneath an open
  // folder, a project's Docs tab — and publishing there would win by mount
  // order over that page's own ScreenHeader and put this title in its bar.
  //
  // The stage supplies the Back, because a pane owns its title and its actions
  // but not the way out of the stage it sits in (and on a wide layout is
  // deliberately given no `onBack` at all).
  const { back, isStage } = useScreenBarLayer()
  const { hidden } = useNativeBarHeader({
    actions: toScreenBarActions(actions),
    back,
    title,
  }, isStage)
  const renderedBack = onBack ?? (isStage ? back?.onBack : undefined)

  return (
    <div className="flex h-full flex-col bg-[color:var(--main)]">
      {hidden
        // The native bar has taken the title and the actions, but it cannot
        // take a pane's toolbar: rendering nothing here would delete the
        // spreadsheet's Sort, Filter, Find and Export from the desktop shell
        // and from iPad, where the header is hidden and there is no other
        // doorway to them.
        ? (below ? <div className="min-w-0 px-[var(--page-gutter)] py-2">{below}</div> : null)
        : (
          <ResponsivePageHeader
            actions={actions}
            below={below}
            onBack={renderedBack}
            title={title}
          />
        )}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
