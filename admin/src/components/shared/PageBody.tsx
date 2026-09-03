import type { ReactNode } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'

type PageBodyProps = {
  children: ReactNode
  /** Spacing/layout classes only — never a width cap. */
  className?: string
}

/**
 * The scrolling content region of a page, below whatever header the page
 * renders.
 *
 * It is **full-width**: content runs edge to edge with one shared horizontal
 * gutter (`--page-gutter`, the same value `ResponsivePageHeader` uses), so the
 * body's first field lines up under the header title on every screen and no
 * empty column is left on either edge. There used to be a `width` prop capping
 * the column at `max-w-2xl`/`3xl`/`5xl`; that left a wide dead strip on the
 * right of every list and settings page, which is the opposite of what the
 * admin wants — dense surfaces filling the width they are given.
 *
 * This component owns the body and nothing above it. Page headers, their
 * action rows and the navigation chrome are another session's; a surface
 * composes `PageBody` underneath its existing header without touching it.
 *
 * It is **not** for a board, a canvas or a column browser: those are
 * fixed-height regions that scroll inside themselves and need an unbroken
 * `flex h-full min-h-0` chain that this component's scrolling wrapper would
 * sever. They keep their own shell.
 */
export const PageBody = ({ children, className }: PageBodyProps) => (
  <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-5">
    <div className={['grid w-full gap-6', className ?? ''].filter(Boolean).join(' ')}>
      {children}
    </div>
  </div>
)

type SectionProps = {
  /**
   * Controls that belong to this section rather than to the page — "Add
   * column", a count, a filter. They sit on the heading row's right edge.
   */
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** A sentence under the heading. Body prose, so `--tx2`, not `--tx3`. */
  description?: ReactNode
  title: ReactNode
}

/**
 * A titled block of a page body — a heading, an optional sentence, and the
 * content — with **no frame of its own**.
 *
 * This is the default grouping, and it exists because wrapping every block in
 * a card is what produced the nested boxes the content system removes. A
 * `Card` is for something that must read as one object (a record in a list, a
 * stat, a form panel); a run of related controls under a heading is a
 * `Section`.
 */
export const Section = ({
  actions,
  children,
  className,
  description,
  title,
}: SectionProps) => (
  <section className={['grid gap-3', className ?? ''].filter(Boolean).join(' ')}>
    <div className="flex items-baseline justify-between gap-4">
      <div className="grid gap-1">
        <SectionLabel as="h2" size="sm">
          {title}
        </SectionLabel>
        {description ? (
          <p className="text-sm text-[color:var(--tx2)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
    {children}
  </section>
)
