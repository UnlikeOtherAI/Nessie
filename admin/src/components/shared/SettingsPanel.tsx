import type { ReactNode } from 'react'
import { ScreenHeader } from './ScreenHeader'
import type { PageHeaderAction } from './ResponsivePageHeader'

interface SettingsPanelProps {
  eyebrow: string
  title: string
  actions?: PageHeaderAction[]
  children: ReactNode
}

/**
 * Shared frame for every admin settings sub-page: a fixed 50px header
 * (eyebrow + title, optional right-aligned actions) over a scrollable body.
 * Mirrors the layout of the governance pages (Audit, Approvals, …) so the
 * admin area reads as one coherent surface.
 */
export const SettingsPanel = ({ eyebrow, title, actions, children }: SettingsPanelProps) => (
  <section className="flex h-full min-h-0 flex-col">
    <ScreenHeader actions={actions} eyebrow={eyebrow} title={title} />
    <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-5">{children}</div>
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
