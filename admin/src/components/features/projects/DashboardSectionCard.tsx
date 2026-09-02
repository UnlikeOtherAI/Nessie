import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SectionLabel } from '../../primitives/SectionLabel'

export type SectionLink = {
  label: string
  to: string
}

type DashboardSectionCardProps = {
  title: string
  // Rendered after the title as `TITLE · N`. Omitted while the section loads.
  count?: number
  // Right-aligned header destinations — the dashboard's stand-in for the
  // Projects tab bar, which the chat entry point deliberately does not grow.
  links?: SectionLink[]
  className?: string
  children: ReactNode
}

export const DashboardSectionCard = ({
  title,
  count,
  links,
  className,
  children,
}: DashboardSectionCardProps) => (
  <section className={['admin-card overflow-hidden', className ?? ''].join(' ')}>
    <header className="flex items-center gap-3 px-4 pb-2 pt-3">
      <SectionLabel as="h2">
        {title}
        {typeof count === 'number' ? ` · ${count}` : ''}
      </SectionLabel>
      {links && links.length > 0 ? (
        <nav className="ml-auto flex items-center gap-2 text-xs">
          {links.map((link, index) => (
            <span className="flex items-center gap-2" key={link.to + link.label}>
              {index > 0 ? <span className="text-[color:var(--tx3)]">·</span> : null}
              <Link
                className="text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                to={link.to}
              >
                {link.label}
                {links.length === 1 ? ' →' : ''}
              </Link>
            </span>
          ))}
        </nav>
      ) : null}
    </header>
    <div className="px-2 pb-2">{children}</div>
  </section>
)

/** Quiet one-liner used for both empty and failed sections. */
export const SectionNotice = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-3 text-sm leading-5 text-[color:var(--tx3)]">{children}</p>
)

/** "…and N more" — a hint, not a control: the owning surface is a click away. */
export const SectionOverflowHint = ({ count, noun }: { count: number; noun: string }) =>
  count > 0 ? (
    <p className="px-2 py-1.5 text-xs text-[color:var(--tx3)]">
      …and {count} more {count === 1 ? noun : `${noun}s`}
    </p>
  ) : null

/** The shared hover/typography treatment for a clickable dashboard row. */
export const dashboardRowClass = [
  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
  'hover:bg-[color:var(--overlay)]',
].join(' ')
