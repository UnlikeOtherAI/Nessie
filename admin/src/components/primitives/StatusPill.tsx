import type { ReactNode } from 'react'

type StatusPillTone = 'accent' | 'danger' | 'muted' | 'success' | 'warning'

type StatusPillProps = {
  children: ReactNode
  tone?: StatusPillTone
}

const toneClasses: Record<StatusPillTone, string> = {
  accent: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  danger: 'bg-[color:var(--danger)]/10 text-[color:var(--danger)]',
  muted: 'bg-[color:var(--ink)]/6 text-[color:var(--muted)]',
  success: 'bg-emerald-500/12 text-emerald-700',
  warning: 'bg-[color:var(--warning)]/12 text-[color:var(--warning)]',
}

export const StatusPill = ({ children, tone = 'muted' }: StatusPillProps) => (
  <span
    className={[
      'inline-flex items-center rounded-full px-2.5 py-1',
      'text-[11px]',
      'font-semibold uppercase tracking-[0.16em]',
      toneClasses[tone],
    ].join(' ')}
  >
    {children}
  </span>
)
