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
   * Pinned below the scroll region rather than inside it — a paged list's
   * `PaginationFooter`, which must not scroll away from the table it pages.
   */
  footer?: ReactNode
  onBack?: () => void
  subtitle?: ReactNode
  tabs?: ReactNode
}

/**
 * Shared frame for every admin settings sub-page: the shared page header
 * (eyebrow + title, optional subtitle, tab strip and right-aligned actions)
 * over a scrollable body, with an optional pinned footer. Mirrors the layout of
 * the governance pages (Audit, Approvals, …) so the admin area reads as one
 * coherent surface.
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
    <ScreenHeader
      actions={actions}
      {...(backLabel ? { backLabel } : {})}
      eyebrow={eyebrow}
      {...(onBack ? { onBack } : {})}
      {...(subtitle ? { subtitle } : {})}
      {...(tabs ? { tabs } : {})}
      title={title}
    />
    <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-5">{children}</div>
    {footer}
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
