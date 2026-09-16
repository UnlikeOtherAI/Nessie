import type {
  DragEventHandler,
  FocusEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  ReactNode,
  Ref,
  TouchEventHandler,
} from 'react'
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
  /**
   * `listbox` for a list whose rows are a selection rather than a set of
   * links — the Finder's columns, where a row is selected and *then* opened.
   * Its rows must say `role="option"` and `ariaSelected`.
   */
  role?: 'listbox'
  /**
   * `finder` is the file browser's list: no frame, no dividers, and 6px of
   * side padding so a selected row's pill runs the column's width. The
   * frame/divider rules below are what a *record* list wants and what every
   * other call site keeps; a browser column is not a card.
   */
  variant?: 'default' | 'finder'
}

export const RowList = ({
  children,
  className,
  label,
  role,
  variant = 'default',
}: RowListProps) => {
  const insideCard = useInsideCard()
  const finder = variant === 'finder'

  return (
    <ul
      aria-label={label}
      className={[
        finder ? 'finder-rows' : 'divide-y divide-[color:var(--sep)]',
        finder || insideCard
          ? ''
          : 'overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      role={role}
    >
      {children}
    </ul>
  )
}

export type RowDragHandlers = {
  onDragEnd?: DragEventHandler<HTMLElement>
  onDragEnter?: DragEventHandler<HTMLElement>
  onDragLeave?: DragEventHandler<HTMLElement>
  onDragOver?: DragEventHandler<HTMLElement>
  onDragStart?: DragEventHandler<HTMLElement>
  onDrop?: DragEventHandler<HTMLElement>
}

export type RowProps = {
  /**
   * Overrides what assistive tech announces for an interactive row. The
   * visible title is the label by default, which is right for most rows; use
   * this where the title alone does not say what activating the row does
   * ("Open folder Designs" against a row reading "Designs").
   */
  ariaLabel?: string
  /** `role="option"`'s state. Paints the selection with `selectionStyle`. */
  ariaSelected?: boolean
  /**
   * True while this row's own column holds focus. A macOS browser paints the
   * active column's selection in the accent and every other column's in grey,
   * which is how a person tells "where I am" from "how I got here".
   */
  columnActive?: boolean
  /** `data-*` hooks, for a menu/drag layer that attaches later and for tests. */
  data?: Record<string, string>
  /** Announced and painted as unavailable; drops hover, keeps the row. */
  disabled?: boolean
  dragHandlers?: RowDragHandlers
  /** HTML5 drag source. */
  draggable?: boolean
  /** The rows being dragged fade; the source keeps its place in the column. */
  dragging?: boolean
  /** Under a drag that may be released here. */
  dropTarget?: boolean
  /** The rendered control, for roving focus and for anchoring a menu. */
  elementRef?: Ref<HTMLButtonElement>
  onContextMenu?: MouseEventHandler<HTMLElement>
  onDoubleClick?: MouseEventHandler<HTMLElement>
  onKeyDown?: KeyboardEventHandler<HTMLElement>
  onMouseDown?: MouseEventHandler<HTMLElement>
  /**
   * `prewarmRowHandlers(prewarm, to)` for a row that navigates: the fetch
   * starts on the press, not on the landing, so the 300ms slide has something
   * to arrive at (`navigation/prewarm.ts`).
   */
  prewarm?: {
    onFocus?: FocusEventHandler<HTMLElement>
    onPointerDown?: PointerEventHandler<HTMLElement>
    onTouchStart?: TouchEventHandler<HTMLElement>
  }
  role?: 'option'
  /**
   * `border` is the left accent edge plus a soft fill, which is what the five
   * drill-down lists and the column browser's card already draw. `pill` is the
   * Finder's: the whole row becomes an `--accent` rounded pill with
   * `--on-accent` text. Two modes, not a fourth row component — the 2026-09-01
   * audit counted six.
   */
  selectionStyle?: 'border' | 'pill'
  /**
   * List view's cells, after the name and before the trailing lane. They are
   * laid out on the *row's* own grid rather than inside the trailing lane, so
   * a column lines up with the sortable header above it — a second grid
   * nested in a shrink-to-fit lane does not, which is how a Date column ends
   * up a different width on every row.
   */
  gridCells?: ReactNode
  /** The row's track, without the leading and trailing lanes it adds itself. */
  gridTemplate?: string
  /** `finder` is 44px with no vertical padding of its own. */
  size?: 'default' | 'finder'
  tabIndex?: number
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

// The Finder row's geometry only. Its selection, hover, focus, drag and drop
// paint live in `.finder-row` in styles.css, where an unlayered rule can win
// against the reset (`button { font: inherit }`) and where a theme can move
// them — a row that spells its colours as utilities has nothing for a
// stylesheet rule to attach to, which is how the page header's hover became a
// live rule that painted nothing.
const finderBodyClass = [
  'finder-row flex w-full items-center gap-1.5 px-2 text-left',
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
  ariaSelected,
  children,
  className,
  columnActive = true,
  data,
  depth = 0,
  disabled = false,
  dragHandlers,
  draggable,
  dragging,
  dropTarget,
  elementRef,
  gridCells,
  gridTemplate,
  href,
  leading,
  onClick,
  onContextMenu,
  onDoubleClick,
  onKeyDown,
  onMouseDown,
  prewarm,
  role,
  selected = false,
  selectionStyle = 'border',
  size = 'default',
  subtitle,
  tabIndex,
  title,
  trailing,
}: RowProps) => {
  const interactive = Boolean(href || onClick)
  const finder = size === 'finder' || selectionStyle === 'pill'
  const grid = Boolean(gridTemplate)
  const content = grid ? (
    <>
      <span className="finder-row-icon flex items-center">{leading}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="finder-row-title min-w-0 flex-1 truncate text-[color:var(--tx)]">
          {title}
        </span>
        {children}
      </span>
      {gridCells}
      <span className="finder-row-trailing flex items-center justify-end gap-2">{trailing}</span>
    </>
  ) : (
    <>
      {leading ? (
        <span className="finder-row-icon flex shrink-0 items-center">{leading}</span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="finder-row-title block truncate text-[color:var(--tx)]">
          {title}
        </span>
        {subtitle ? (
          <span className="finder-row-sub mt-0.5 block truncate text-xs text-[color:var(--tx3)]">
            {subtitle}
          </span>
        ) : null}
        {children}
      </span>
      {trailing ? (
        <span className="finder-row-trailing flex shrink-0 items-center gap-2">{trailing}</span>
      ) : null}
    </>
  )

  const classes = finder
    ? [
        grid ? 'finder-row finder-grid-row px-2 text-left transition-colors' : finderBodyClass,
        className ?? '',
      ].filter(Boolean).join(' ')
    : [
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

  const style = grid
    ? { ['--finder-grid-columns' as string]: gridTemplate }
    : depth > 0
      ? { paddingLeft: `${8 + depth * 14}px` }
      : undefined

  // Spelt out rather than spread: a rest prop here would also let a call site
  // pass `style`, a second radius or its own colours, which is the drift the
  // two modes above exist to prevent.
  const shared = {
    'aria-disabled': disabled || undefined,
    'aria-label': ariaLabel,
    'aria-selected': ariaSelected,
    'data-dragging': dragging ? 'true' : undefined,
    'data-drop-target': dropTarget ? 'true' : undefined,
    'data-column-active': finder ? String(columnActive) : undefined,
    onContextMenu,
    onDoubleClick,
    onKeyDown,
    onMouseDown,
    role,
    ...prewarm,
    ...data,
    ...(draggable ? { draggable: true, ...dragHandlers } : dragHandlers ?? {}),
  }

  return (
    <li className={finder ? 'finder-row-item' : undefined}>
      {href ? (
        <Link
          {...shared}
          aria-current={selected && !role ? 'true' : undefined}
          className={classes}
          style={style}
          to={href}
        >
          {content}
        </Link>
      ) : onClick ? (
        <button
          {...shared}
          aria-current={selected && !role ? 'true' : undefined}
          className={classes}
          onClick={onClick}
          ref={elementRef}
          style={style}
          tabIndex={tabIndex}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div {...shared} className={classes} style={style}>
          {content}
        </div>
      )}
    </li>
  )
}
