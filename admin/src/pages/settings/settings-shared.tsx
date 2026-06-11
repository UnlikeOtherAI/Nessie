import type { ReactNode } from 'react'
import { MobileMenuButton } from '../../layouts/admin-shell/MobileMenuButton'

export const sectionTitleClass =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const hoverCardClass = [
  'admin-card p-3 text-left',
  'hover:bg-[color:var(--main-hover)]',
].join(' ')

interface SettingsPanelProps {
  eyebrow: string
  title: string
  actions?: ReactNode
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
    <header
      className={[
        'flex h-[50px] items-center justify-between',
        'border-b border-[color:var(--sep)] px-5',
      ].join(' ')}
    >
      <div className="flex min-w-0 items-center gap-1">
        <MobileMenuButton />
        <div className="min-w-0">
          <div className={sectionTitleClass}>{eyebrow}</div>
          <h1 className="mt-1 truncate text-[17px] font-bold text-[color:var(--tx)]">{title}</h1>
        </div>
      </div>
      {actions}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
  </section>
)
