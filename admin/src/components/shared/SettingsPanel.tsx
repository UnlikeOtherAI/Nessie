import type { ReactNode } from 'react'
import { ScreenHeader } from './ScreenHeader'
import type { PageHeaderAction } from './ResponsivePageHeader'

/**
 * A settings page that is one tab of a larger screen. The host owns the
 * screen: its tab strip, its name and eyebrow, and — for a record's page — its
 * Back. The page keeps its own header actions, subtitle and footer, because
 * those depend on the page's own state (Notifications' Save button is bound to
 * its form's hydration). Exactly one tab renders at a time, so there is still
 * exactly one header on screen, and it names the screen rather than the tab.
 */
export type SettingsTabHostProps = {
  backLabel?: string
  eyebrow?: string
  onBack?: () => void
  tabs?: ReactNode
  title?: string
}

interface SettingsPanelProps {
  eyebrow: string
  title: string
  actions?: PageHeaderAction[]
  /** A settings page pushed from another one: Status → one status. */
  backLabel?: string
  children: ReactNode
  /**
   * Pinned below the scroll area, outside it — where a paged list puts its
   * `PaginationFooter` so the control stays reachable without scrolling to the
   * end of the rows it pages, and the body above it does not grow and shrink
   * as pages change. This is the layout `AgentsList` already has. The gutter
   * is this frame's, so a caller passes the footer bare.
   */
  footer?: ReactNode
  /**
   * The screen hosting this page as one of its tabs. What it names wins over
   * the page's own eyebrow, title and Back; its tab strip is the header's.
   */
  host?: SettingsTabHostProps
  onBack?: () => void
  /** The header's own description line, not a paragraph inside the body. */
  subtitle?: ReactNode
  /** The page's `TabBar`, as the header's tabs slot rather than a second bar. */
  tabs?: ReactNode
}

/**
 * Shared frame for every admin settings sub-page: the shared page header
 * (eyebrow + title, optional Back, right-aligned actions, description and tab
 * strip) over a scrollable body, with an optional pinned footer. Mirrors the
 * layout of the governance pages (Audit, Approvals, …) so the admin area reads
 * as one coherent surface.
 */
export const SettingsPanel = ({
  actions,
  backLabel,
  children,
  eyebrow,
  footer,
  host,
  onBack,
  subtitle,
  tabs,
  title,
}: SettingsPanelProps) => {
  const back = host?.onBack ?? onBack
  const label = host?.onBack ? host.backLabel : backLabel
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        actions={actions}
        {...(label ? { backLabel: label } : {})}
        eyebrow={host?.eyebrow ?? eyebrow}
        {...(back ? { onBack: back } : {})}
        subtitle={subtitle}
        tabs={host?.tabs ?? tabs}
        title={host?.title ?? title}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-5">{children}</div>
      {footer ? <div className="px-[var(--page-gutter)]">{footer}</div> : null}
    </section>
  )
}
