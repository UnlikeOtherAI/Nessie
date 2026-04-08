import type { ReactNode } from 'react'

type StatusPillTone = 'accent' | 'danger' | 'muted' | 'success' | 'warning'

type StatusPillProps = {
  children: ReactNode
  tone?: StatusPillTone
}

const toneClasses: Record<StatusPillTone, string> = {
  accent: 'bg-[rgba(124,58,237,0.16)] text-[#a78bfa]',
  danger: 'bg-red-500/12 text-red-300',
  muted: 'bg-white/6 text-[color:var(--tx3)]',
  success: 'bg-emerald-500/12 text-emerald-300',
  warning: 'bg-amber-500/12 text-amber-300',
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
