import type { ReactNode } from 'react'

type EmptyStateProps = {
  children: ReactNode
}

export const EmptyState = ({ children }: EmptyStateProps) => (
  <div
    className={[
      'rounded-[1.5rem] border border-dashed border-[color:var(--line)]',
      'bg-white/50 p-5 text-sm leading-6',
      'text-[color:var(--muted)]',
    ].join(' ')}
  >
    {children}
  </div>
)
