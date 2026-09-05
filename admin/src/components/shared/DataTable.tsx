import type { ReactNode } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'
import { SkeletonBlock } from '../primitives/Skeleton'
import { ExpandableTable } from './ExpandableTable'

/**
 * The admin's one table.
 *
 * Seven `<table>` elements existed and they disagreed on everything a reader
 * notices: one wrapped itself in an extra frame, one hid a column below `sm`
 * while its sibling pinned a min-width and scrolled, one drew skeleton rows
 * while its sibling wrote "Loading…" in a cell, and the dashboard's table
 * opted out of the shared zebra entirely. None offered sorting.
 *
 * Columns are data, not markup, so the header cells, the alignment and the
 * skeleton can be derived rather than hand-kept in sync. Sorting is a server
 * round-trip by design — `onSortChange` reports the intent and the caller
 * re-queries; a table that re-sorts the page it happens to be holding lies
 * about the rows it is not holding.
 *
 * It owns its own frame and is never placed inside a `Card`.
 */

export type SortOrder = 'asc' | 'desc'

export type SortState = {
  field: string
  order: SortOrder
}

export type DataTableColumn<T> = {
  align?: 'left' | 'right'
  header: string
  /** Matches the API's `sort` field name when `sortable`. */
  key: string
  render: (row: T) => ReactNode
  /**
   * Drops the column below the `sm` breakpoint. The caller is expected to fold
   * that value into the primary cell there, as `ActiveSessionsTable` does —
   * hiding data outright is not what this is for.
   */
  secondary?: boolean
  sortable?: boolean
  /** A CSS width for the column, e.g. `'1px'` to shrink-wrap an actions cell. */
  width?: string
}

type DataTableProps<T> = {
  columns: DataTableColumn<T>[]
  /** Shown in place of the body when there are no rows and nothing is loading. */
  empty?: ReactNode
  /** Whether this surface offers a full-screen inspection view for the table. */
  expandable: boolean
  /** Names the table for assistive tech and titles the expand dialog. */
  label: string
  loading?: boolean
  /**
   * Keeps real columns readable on a narrow viewport; the viewport scrolls.
   *
   * Applied as `max(<value>, 100%)` because the scroll viewport's own
   * `min-width: 100%` (styles.css, `.admin-expandable-table__viewport > table`)
   * is a stylesheet rule an inline `min-width` silently outranks — so every
   * table that passed one shrink-wrapped its content and left its header rule
   * and zebra rows stopping short of the frame drawn around them.
   */
  minWidth?: string
  onRowClick?: (row: T) => void
  /** Adds the standard trailing disclosure action for a row-level detail view. */
  rowActionLabel?: (row: T) => string
  onSortChange?: (next: SortState) => void
  /**
   * Per-row presentation, for a row the surface must show but must not present
   * as live — the Secrets table's rows pinned by a lock a level above, which
   * `ScopedSettingGate` renders the same way for a single control. It is a
   * class rather than a boolean because "dimmed" is one of the shapes this
   * takes, not the only one; it is never used to encode a row's data.
   */
  rowClassName?: (row: T) => string | undefined
  rowKey: (row: T) => string
  rows: T[]
  skeletonRows?: number
  sort?: SortState
}

const headCellClass = 'px-4 py-2 text-left'

const cellClass = 'px-4 py-3 align-middle text-sm text-[color:var(--tx)]'

const SortIndicator = ({ order }: { order: SortOrder }) => (
  <span aria-hidden="true" className="ml-1 text-[color:var(--tx3)]">
    {order === 'asc' ? '↑' : '↓'}
  </span>
)

export const DataTable = <T,>({
  columns,
  empty,
  expandable,
  label,
  loading = false,
  minWidth,
  onRowClick,
  rowActionLabel,
  onSortChange,
  rowClassName,
  rowKey,
  rows,
  skeletonRows = 5,
  sort,
}: DataTableProps<T>) => {
  const body = (
    <table
      className="admin-table w-full border-collapse"
      style={minWidth ? { minWidth: `max(${minWidth}, 100%)` } : undefined}
    >
      <caption className="sr-only">{label}</caption>
      <thead>
        <tr className="border-b border-[color:var(--sep)]">
          {columns.map((column) => {
            const active = sort?.field === column.key
            const nextOrder: SortOrder = active && sort?.order === 'asc' ? 'desc' : 'asc'

            return (
              <th
                aria-sort={active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : undefined}
                className={[
                  headCellClass,
                  column.align === 'right' ? 'text-right' : '',
                  column.secondary ? 'hidden sm:table-cell' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
              >
                {column.sortable && onSortChange ? (
                  <button
                    className="inline-flex items-center hover:text-[color:var(--tx)]"
                    onClick={() => onSortChange({ field: column.key, order: nextOrder })}
                    type="button"
                  >
                    <SectionLabel as="span" size="2xs">
                      {column.header}
                    </SectionLabel>
                    {active && sort ? <SortIndicator order={sort.order} /> : null}
                  </button>
                ) : (
                  <SectionLabel as="span" size="2xs">
                    {column.header}
                  </SectionLabel>
                )}
              </th>
            )
          })}
          {onRowClick && rowActionLabel ? <th className={headCellClass} scope="col"><span className="sr-only">Open</span></th> : null}
        </tr>
      </thead>
      <tbody>
        {loading
          ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
            <tr key={`skeleton-${rowIndex}`}>
              {columns.map((column) => (
                <td
                  className={[cellClass, column.secondary ? 'hidden sm:table-cell' : '']
                    .filter(Boolean)
                    .join(' ')}
                  key={column.key}
                >
                  <SkeletonBlock className="h-4 w-full" />
                </td>
              ))}
              {onRowClick && rowActionLabel ? <td className={cellClass}><SkeletonBlock className="ml-auto h-4 w-4" /></td> : null}
            </tr>
          ))
          : rows.map((row) => (
            <tr
              className={[onRowClick ? 'cursor-pointer' : '', rowClassName?.(row) ?? '']
                .filter(Boolean)
                .join(' ') || undefined}
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onRowClick(row)
                    }
                  }
                : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((column) => (
                <td
                  className={[
                    cellClass,
                    column.align === 'right' ? 'text-right tabular-nums' : '',
                    column.secondary ? 'hidden sm:table-cell' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={column.key}
                >
                  {column.render(row)}
                </td>
              ))}
              {onRowClick && rowActionLabel ? (
                <td className={`${cellClass} text-right`}>
                  <button
                    aria-label={rowActionLabel(row)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[color:var(--main-hover)] hover:text-[color:var(--tx)]"
                    onClick={(event) => {
                      event.stopPropagation()
                      onRowClick(row)
                    }}
                    type="button"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
      </tbody>
    </table>
  )

  if (!loading && rows.length === 0 && empty) {
    return <>{empty}</>
  }

  return (
    <ExpandableTable
      className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
      expandable={expandable}
      label={label}
    >
      {body}
    </ExpandableTable>
  )
}
