import type { MouseEventHandler, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useInsideCard } from './Card'

/**
 * A list of records that are not tabular — an icon, a name, a line of detail,
 * maybe a chip and an action. Six independent shapes of this existed: the
 * `divide-y` bordered container copied into ten files, `admin-card p-3` rows,
 * `hoverCardClass` links, bare `<ul>` hover rows, `dashboardRowClass` buttons
 * and `rowShell` list items. They differed in padding, divider, hover, radius
 * and selected state, and none of those differences meant anything.
 *
 * **The frame is automatic.** Standing on its own, the list draws a border and
 * divides its rows. Inside a {@link Card} it draws neither — dividers only —
 * because a bordered box inside a bordered box is the nesting the content
 * system forbids. A caller never decides this, so it cannot get it wrong.
 */

type RowListProps = {
  children: ReactNode
  className?: string
  /** Announced to assistive tech as the name of the list. */
  label?: string
}

export const RowList = ({ children, className, label }: RowListProps) => {
  const insideCard = useInsideCard()

  return (
    <ul
      aria-label={label}
      className={[
        'divide-y divide-[color:var(--sep)]',
        insideCard
          ? ''
          : 'overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </ul>
  )
}

type RowProps = {
  /**
   * Overrides what assistive tech announces for an interactive row. The
   * visible title is the label by default, which is right for most rows; use
   * this where the title alone does not say what activating the row does
   * ("Open folder Designs" against a row reading "Designs").
   */
  ariaLabel?: string
  /** Right-hand side: a chip, a timestamp, a control. Never the whole action. */
  trailing?: ReactNode
  children?: ReactNode
  className?: string
  /** An avatar, an icon, a status dot. */
  leading?: ReactNode
  /** A tree depth, indented 18px per level — the knowledge browser's step. */
  depth?: number
  href?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
  /**
   * The accent-marked current row of a browsable list. It is a left border
   * plus a soft fill, which is what the five drill-down lists already drew;
   * the knowledge browser's neutral `--overlay` and the column browser's
   * `--success-*` (a success tone doing duty as "selected") both fold in here.
   */
  selected?: boolean
  subtitle?: ReactNode
  title: ReactNode
}

const bodyClass = [
  'flex w-full items-center gap-3 px-3 py-2.5 text-left',
  'transition-colors',
].join(' ')

const interactiveClass = 'hover:bg-[color:var(--overlay-weak)]'

const selectedClass = 'bg-[color:var(--accent-soft)]'

/**
 * One record. Renders as a link, a button, or a plain row depending on what it
 * can do — a row that does nothing must not look or tab like a control, which
 * is the affordance several of the hand-rolled lists got wrong in both
 * directions.
 */
export const Row = ({
  ariaLabel,
  children,
  className,
  depth = 0,
  href,
  leading,
  onClick,
  selected = false,
  subtitle,
  title,
  trailing,
}: RowProps) => {
  const interactive = Boolean(href || onClick)
  const content = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[color:var(--tx)]">{title}</span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">
            {subtitle}
          </span>
        ) : null}
        {children}
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-2">{trailing}</span>
      ) : null}
    </>
  )

  const classes = [
    bodyClass,
    // The accent edge marks the selected row; the transparent one on every
    // other row keeps the text from shifting 2px when selection moves.
    'border-l-2',
    selected ? 'border-[color:var(--accent)]' : 'border-transparent',
    selected ? selectedClass : '',
    interactive ? interactiveClass : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const style = depth > 0 ? { paddingLeft: `${12 + depth * 18}px` } : undefined

  return (
    <li>
      {href ? (
        <Link
          aria-current={selected ? 'true' : undefined}
          aria-label={ariaLabel}
          className={classes}
          style={style}
          to={href}
        >
          {content}
        </Link>
      ) : onClick ? (
        <button
          aria-current={selected ? 'true' : undefined}
          aria-label={ariaLabel}
          className={classes}
          onClick={onClick}
          style={style}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div className={classes} style={style}>
          {content}
        </div>
      )}
    </li>
  )
}
