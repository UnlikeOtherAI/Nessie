import type { ReactNode } from 'react'
import { ScreenHeader } from './ScreenHeader'
import type { PageHeaderAction } from './ResponsivePageHeader'

interface SettingsPanelProps {
  eyebrow: string
  title: string
  actions?: PageHeaderAction[]
  /** A settings page pushed from another one: Statuses → one status. */
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
  onBack,
  subtitle,
  tabs,
  title,
}: SettingsPanelProps) => (
  <section className="flex h-full min-h-0 flex-col">
    {/* `backLabel` and `onBack` are spread rather than passed through: both are
        string/function-typed on `ScreenHeader`, so an explicit `undefined`
        would not satisfy them. `subtitle` and `tabs` are `ReactNode`, which
        already includes it. */}
    <ScreenHeader
      actions={actions}
      {...(backLabel ? { backLabel } : {})}
      eyebrow={eyebrow}
      {...(onBack ? { onBack } : {})}
      subtitle={subtitle}
      tabs={tabs}
      title={title}
    />
    <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-5">{children}</div>
    {footer ? <div className="px-[var(--page-gutter)]">{footer}</div> : null}
  </section>
)

/**
 * A settings page that is one tab of a larger settings screen. The parent owns
 * the tab strip and hands it down; the page keeps its own header, title and
 * actions, because those depend on the page's own state (Notifications' Save
 * button is bound to its form's hydration). Exactly one tab renders at a time,
 * so there is still exactly one header on screen.
 */
export type SettingsTabHostProps = { tabs?: ReactNode }
