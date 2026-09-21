import type { ReactNode } from 'react'

type SidebarTreeSectionHeaderProps = {
  action?: ReactNode
  controls?: string
  children: ReactNode
  className?: string
  collapsed: boolean
  interactive?: boolean
  onToggle: () => void
}

export const SidebarTreeNode = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={['sidebar-tree-node', className].filter(Boolean).join(' ')}>{children}</div>
)

export const SidebarTreeChevron = ({ expanded, className = '' }: { expanded: boolean; className?: string }) => (
  <svg
    aria-hidden="true"
    className={['h-2.5 w-2.5 shrink-0 text-[color:var(--tx3)] transition-transform', expanded ? '' : '-rotate-90', className].filter(Boolean).join(' ')}
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    viewBox="0 0 24 24"
  >
    <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const SidebarTreeLeading = ({ children }: { children: ReactNode }) => (
  <span className="flex w-7 shrink-0 items-center gap-1.5">{children}</span>
)

/**
 * Shared visual shell for the compact tree shown beside Channels and
 * Knowledge. It deliberately owns no selection, expansion, or navigation;
 * those remain with each surface's existing controller.
 */
export const SidebarTreePanel = ({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) => (
  <div className={['sidebar-tree-panel', className].filter(Boolean).join(' ')}>
    {children}
  </div>
)

export const SidebarTreeChildren = ({
  children,
  className = '',
  id,
}: {
  children: ReactNode
  className?: string
  id?: string
}) => (
  <div className={['sidebar-tree-children', className].filter(Boolean).join(' ')} id={id}>
    {children}
  </div>
)

export const SidebarTreeSectionHeader = ({
  action,
  children,
  className = '',
  collapsed,
  controls,
  interactive = true,
  onToggle,
}: SidebarTreeSectionHeaderProps) => {
  const label = (
    <>
      <SidebarTreeChevron expanded={!collapsed} />
      {children}
    </>
  )

  return (
    <div className={['sidebar-tree-section', className].filter(Boolean).join(' ')}>
      <div className="admin-sec-row">
        {interactive ? (
          <button
            aria-controls={controls}
            aria-expanded={!collapsed}
            className="admin-sec-hdr"
            onClick={onToggle}
            type="button"
          >
            {label}
          </button>
        ) : (
          <div className="admin-sec-hdr">{label}</div>
        )}
        {action}
      </div>
    </div>
  )
}
