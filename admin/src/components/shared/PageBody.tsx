import type { ReactNode } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'

/**
 * The reading width of a page's content, named for what it holds rather than
 * for a pixel count.
 *
 * - `narrow` — a single column of form fields or prose (`max-w-2xl`).
 * - `regular` — the default: a detail pane, a settings page, a list of
 *   records (`max-w-3xl`).
 * - `wide` — a page whose content is genuinely two-dimensional: a table with
 *   real columns, a grid of cards (`max-w-5xl`).
 *
 * Seven sibling project tabs shipped six different widths, so the point of
 * naming them is that a person moving between two pages of the same kind
 * never sees the column jump.
 *
 * There is deliberately **no `full`**. A board, a canvas or a column browser
 * is not a wide reading column — it is a fixed-height region that scrolls
 * inside itself, and it needs an unbroken `flex h-full min-h-0` chain that
 * this component's scrolling wrapper would sever. Those surfaces keep their
 * own shell, and a `full` token here would have been a name promising
 * something the markup underneath it could not do.
 */
export type PageBodyWidth = 'narrow' | 'regular' | 'wide'

const widthClasses: Record<PageBodyWidth, string> = {
  narrow: 'max-w-2xl',
  regular: 'max-w-3xl',
  wide: 'max-w-5xl',
}

type PageBodyProps = {
  children: ReactNode
  /** Spacing only; width comes from `width` so two pages cannot disagree. */
  className?: string
  width?: PageBodyWidth
}

/**
 * The scrolling content region of a page, below whatever header the page
 * renders.
 *
 * It is deliberately left-aligned rather than centred: the page header's title
 * sits at the left gutter, and a centred body would put every heading and
 * every first field out of line with it.
 *
 * This component owns the body and nothing above it. Page headers, their
 * action rows and the navigation chrome are another session's; a surface
 * composes `PageBody` underneath its existing header without touching it.
 */
export const PageBody = ({ children, className, width = 'regular' }: PageBodyProps) => (
  <div className="min-h-0 flex-1 overflow-y-auto p-5">
    <div
      className={['grid w-full gap-6', widthClasses[width], className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
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
