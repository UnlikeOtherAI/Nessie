import type { ReactNode } from 'react'

type EmptyStateProps = {
  children: ReactNode
}

export const EmptyState = ({ children }: EmptyStateProps) => (
  <div
    className={[
      'rounded-xl border border-dashed border-[color:var(--sep)]',
      'bg-white/4 p-5 text-sm leading-6 text-[color:var(--tx3)]',
    ].join(' ')}
  >
    {children}
  </div>
)
