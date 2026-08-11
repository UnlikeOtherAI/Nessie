import type { ReactNode } from 'react'
import {
  AdminPageHeader,
} from '../../components/shared/AdminPageHeader'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'

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
    <div
      className={[
        'rounded-md border px-3 py-2 text-sm',
        feedback.kind === 'success'
          ? 'border-[color:var(--success-border)] bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
          : 'border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
      ].join(' ')}
      role="alert"
    >
      {feedback.message}
    </div>
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
export const SettingsPanel = ({ eyebrow, title, actions, children }: SettingsPanelProps) => (
  <section className="flex h-full min-h-0 flex-col">
    <AdminPageHeader actions={actions} eyebrow={eyebrow} title={title} titleTone="page" />
    <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
  </section>
)
