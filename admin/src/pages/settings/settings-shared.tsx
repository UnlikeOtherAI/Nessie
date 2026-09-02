import type { ReactNode } from 'react'
import { Notice } from '../../components/primitives/Notice'
import { ScreenHeader } from '../../components/shared/ScreenHeader'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'

/**
 * The section-label look as a bare class, for the elements `SectionLabel`'s
 * `as` union cannot render — a `<dt>` inside a definition list, where a `<div>`
 * would break the list semantics. Everything else uses the primitive.
 */
export const sectionTitleClass =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const hoverCardClass = [
  'admin-card p-3 text-left',
  'hover:bg-[color:var(--main-hover)]',
].join(' ')

export type SettingsFeedback = { kind: 'success' | 'error'; message: string }

/**
 * Inline success/error banner shared across settings pages. `role="alert"` so
 * the message is announced to assistive tech when it appears after an async
 * action.
 */
export const FeedbackBanner = ({ feedback }: { feedback: SettingsFeedback | null }) => {
  if (!feedback) {
    return null
  }

  return (
    <Notice role="alert" tone={feedback.kind === 'success' ? 'success' : 'danger'}>
      {feedback.message}
    </Notice>
  )
}

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
/**
 * A settings page that is one tab of a larger settings screen. The parent owns
 * the tab strip and hands it down; the page keeps its own header, title and
 * actions, because those depend on the page's own state (Notifications' Save
 * button is bound to its form's hydration). Exactly one tab renders at a time,
 * so there is still exactly one header on screen.
 */
export type SettingsTabHostProps = { tabs?: ReactNode }

export const SettingsPanel = ({ eyebrow, title, actions, children }: SettingsPanelProps) => (
  <section className="flex h-full min-h-0 flex-col">
    <ScreenHeader actions={actions} eyebrow={eyebrow} title={title} />
    <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
  </section>
)
