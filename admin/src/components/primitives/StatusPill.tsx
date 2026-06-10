import type { ReactNode } from 'react'

type StatusPillTone = 'accent' | 'danger' | 'muted' | 'success' | 'warning'

type StatusPillProps = {
  children: ReactNode
  tone?: StatusPillTone
}

const toneClasses: Record<StatusPillTone, string> = {
  accent: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  danger: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  muted: 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]',
  success: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  warning: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
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
