import type { ReactNode } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'
import { Skeleton } from '../primitives/Skeleton'
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
  /** Names the table for assistive tech and titles the expand dialog. */
  label: string
  loading?: boolean
  /** Keeps real columns readable on a narrow viewport; the viewport scrolls. */
  minWidth?: string
  onRowClick?: (row: T) => void
  onSortChange?: (next: SortState) => void
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
  label,
  loading = false,
  minWidth,
  onRowClick,
  onSortChange,
  rowKey,
  rows,
  skeletonRows = 5,
  sort,
}: DataTableProps<T>) => {
  const body = (
    <table
      className="admin-table w-full border-collapse"
      style={minWidth ? { minWidth } : undefined}
    >
      <caption className="sr-only">{label}</caption>
      <thead>
        <tr>
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
                  <Skeleton />
                </td>
              ))}
            </tr>
          ))
          : rows.map((row) => (
            <tr
              className={onRowClick ? 'cursor-pointer' : undefined}
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
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
            </tr>
          ))}
      </tbody>
    </table>
  )

  if (!loading && rows.length === 0 && empty) {
    return <>{empty}</>
  }

  return <ExpandableTable label={label}>{body}</ExpandableTable>
}
