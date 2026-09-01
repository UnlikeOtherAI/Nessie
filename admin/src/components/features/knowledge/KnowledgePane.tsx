import type { ReactNode } from 'react'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../shared/ResponsivePageHeader'

type KnowledgePaneProps = {
  actions?: PageHeaderAction[]
  children: ReactNode
  onBack?: () => void
  title: string
}

// Full-width chrome for the knowledge main area. Its actions use the shared
// responsive header so a project Docs tab can collapse into More without ever
// overlapping the title or an adjacent navigation column. On a phone the
// leading doorway belongs to the outer route header (the shell's
// PhoneNavigationButton, fed by the local-back registry), so panes receive
// onBack only on wider layouts and never paint a second phone Back.
export const KnowledgePane = ({ actions, children, onBack, title }: KnowledgePaneProps) => (
  <div className="flex h-full flex-col bg-[color:var(--main)]">
    <ResponsivePageHeader actions={actions} onBack={onBack} title={title} />
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>
)
