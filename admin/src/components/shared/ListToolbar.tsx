import type { ReactNode } from 'react'
import { Input } from './FormControls'

/**
 * The row above a list: what to search for, what to narrow it to, and how many
 * there are.
 *
 * Two pages had this well-composed already (triggers and tools: search, then a
 * `TabBar` for the primary dimension, then compact selects); everywhere else
 * a filter was either absent from a list that badly needed one — members,
 * statuses, connections, secrets, executors all render unbounded — or written
 * once more from scratch. The count was phrased five different ways.
 *
 * It only ever edits the query the caller sends. **The client filters nothing
 * and sorts nothing**: narrowing a page the browser happens to be holding
 * silently drops every match on the pages it is not holding.
 *
 * A control that already lives in the page header stays in the page header.
 * This is for the body.
 */

type ListToolbarProps = {
  /** Selects and segmented controls that narrow the list. */
  children?: ReactNode
  className?: string
  /**
   * How many records the query matched — the server's `total`, not the length
   * of the page on screen. Rendered on the right so it never moves when the
   * filters wrap.
   */
  count?: ReactNode
  search?: {
    label: string
    onChange: (value: string) => void
    placeholder?: string
    value: string
  }
}

export const ListToolbar = ({ children, className, count, search }: ListToolbarProps) => (
  <div
    className={['flex flex-wrap items-center gap-2', className ?? '']
      .filter(Boolean)
      .join(' ')}
  >
    {search ? (
      <div className="w-full max-w-xs">
        <Input
          aria-label={search.label}
          onChange={(event) => search.onChange(event.target.value)}
          placeholder={search.placeholder ?? search.label}
          type="search"
          value={search.value}
        />
      </div>
    ) : null}

    {children}

    {count !== undefined ? (
      <span className="ml-auto text-xs text-[color:var(--tx3)]">{count}</span>
    ) : null}
  </div>
)
