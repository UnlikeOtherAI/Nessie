import { PAGE_SIZE_OPTIONS } from '@nessie/schemas'

import { Select } from './FormControls'

export type PaginationFooterProps = {
  canNext: boolean
  canPrevious: boolean
  /** Spacing only — layout, page position and page-size control are shared. */
  className?: string
  /**
   * A small, non-actionable list may omit its pager. Paged lists normally keep
   * it visible so people can see the selected page size before it grows.
   */
  hideWhenSinglePage?: boolean
  /** The result range, for example “26–50 of 134”. */
  label: string
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  /** Zero-based internally; the control always speaks one-based pages. */
  page: number
  /** Always at least one while a pager is shown. */
  pageCount: number
  pageSize: number
}

/**
 * The one closing control for a paged list.
 *
 * Every pager states the current page and page count, keeps the range label,
 * and gives the same Items per page selector. The component owns this contract
 * so a list cannot quietly regress to a bare Previous / Next pair.
 */
export const PaginationFooter = ({
  canNext,
  canPrevious,
  className,
  hideWhenSinglePage = false,
  label,
  onPageChange,
  onPageSizeChange,
  page,
  pageCount,
  pageSize,
}: PaginationFooterProps) => {
  if (hideWhenSinglePage && pageCount <= 1) return null

  return (
    <div
      className={[
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-[color:var(--sep)] py-3',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center gap-3">
        <button
          aria-label="Previous page"
          className="admin-button admin-button-secondary"
          disabled={!canPrevious}
          onClick={() => onPageChange(page - 1)}
          type="button"
        >
          Previous
        </button>
        <span aria-live="polite" className="text-sm tabular-nums text-[color:var(--tx2)]">
          Page {page + 1} of {pageCount}
        </span>
        <button
          aria-label="Next page"
          className="admin-button admin-button-secondary"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          type="button"
        >
          Next
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <span className="text-xs tabular-nums text-[color:var(--tx3)]">{label}</span>
        <label className="flex items-center gap-2 text-xs text-[color:var(--tx2)]">
          <span>Items per page</span>
          <Select
            aria-label="Items per page"
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            size="compact"
            value={pageSize}
          >
            {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </Select>
        </label>
      </div>
    </div>
  )
}
