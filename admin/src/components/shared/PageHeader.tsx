import type { ReactNode } from 'react'

type PageHeaderProps = {
  actions?: ReactNode
  eyebrow?: string
  subtitle?: string
  title: string
}

export const PageHeader = ({ actions, eyebrow, subtitle, title }: PageHeaderProps) => (
  <header className="glass-panel rounded-[2rem] p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        {eyebrow ? (
          <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--muted)]">{eyebrow}</p>
        ) : null}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-3 max-w-3xl text-sm leading-6 text-[color:var(--muted)]">{subtitle}</p>
        ) : null}
      </div>
      {actions}
    </div>
  </header>
)
