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
  // They are the whole point of the section (this screen is a doorway, not a
  // report), so they are rendered as real buttons rather than the quiet
  // dot-separated text run they started as: `Open docs`, `Manage` and `Board`
  // were the same weight and colour as the `TITLE · N` beside them, which read
  // as a caption and not as somewhere you could go.
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
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-3">
      <SectionLabel as="h2">
        {title}
        {typeof count === 'number' ? ` · ${count}` : ''}
      </SectionLabel>
      {links && links.length > 0 ? (
        <nav className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {links.map((link) => (
            <Link
              className="admin-button admin-button-secondary admin-button-compact"
              key={link.to + link.label}
              to={link.to}
            >
              {link.label}
            </Link>
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

// "…and N more" is `shared/SectionOverflowHint` — promoted out of this file
// once the kit existed. Import it from there rather than re-adding a local
// copy here.

/** The shared hover/typography treatment for a clickable dashboard row. */
export const dashboardRowClass = [
  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
  'hover:bg-[color:var(--overlay)]',
].join(' ')
