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
  // 'standalone' (default) renders the pane's own Back for the local stack.
  // 'embedded' suppresses it: the surrounding route header already carries the
  // one leading doorway (Project Docs on a phone).
  variant?: 'embedded' | 'standalone'
}

// Full-width chrome for the knowledge main area. Its actions use the shared
// responsive header so a project Docs tab can collapse into More without ever
// overlapping the title or an adjacent navigation column.
export const KnowledgePane = ({ actions, children, onBack, title, variant = 'standalone' }: KnowledgePaneProps) => (
  <div className="flex h-full flex-col bg-[color:var(--main)]">
    <ResponsivePageHeader actions={actions} onBack={variant === 'standalone' ? onBack : undefined} title={title} />
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>
)
