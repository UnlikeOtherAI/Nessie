import type { PropsWithChildren, ReactNode } from 'react'

type SidebarSectionProps = PropsWithChildren<{
  action?: ReactNode
  title: string
}>

export const SidebarSection = ({ action, children, title }: SidebarSectionProps) => (
  <section className="rounded-[1.75rem] border border-[color:var(--line)] bg-white/70 p-4">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--muted)]">
        {title}
      </h2>
      {action}
    </div>
    <div className="mt-4 grid gap-3">{children}</div>
  </section>
)
