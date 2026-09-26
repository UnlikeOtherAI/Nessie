import { PAGE_SIZE_OPTIONS } from '@nessie/schemas'
import { useTranslation } from 'react-i18next'

import { Select } from './FormControls'

export type PaginationFooterProps = {
  canNext: boolean
  canPrevious: boolean
  /** Spacing only — layout, page position and page-size control are shared. */
  className?: string
  /** Stack the position readout below the controls when a sidebar is narrow. */
  compact?: boolean
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
  compact = false,
  hideWhenSinglePage = false,
  label,
  onPageChange,
  onPageSizeChange,
  page,
  pageCount,
  pageSize,
}: PaginationFooterProps) => {
  const { t } = useTranslation('common')
  if (hideWhenSinglePage && pageCount <= 1 && page === 0 && !canPrevious && !canNext) return null

  return (
    <div
      className={[
        compact
          ? 'flex flex-col items-stretch gap-2 border-t border-[color:var(--sep)] py-3'
          : 'flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-[color:var(--sep)] py-3',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={compact ? 'flex items-center justify-between gap-3' : 'flex items-center gap-3'}>
        <button
          aria-label={t('pagination.previousPage')}
          className="admin-button admin-button-secondary"
          disabled={!canPrevious}
          onClick={() => onPageChange(page - 1)}
          type="button"
        >
          {t('pagination.previous')}
        </button>
        {!compact ? (
          <span aria-live="polite" className="text-sm tabular-nums text-[color:var(--tx2)]">
            {t('pagination.pageOf', { page: page + 1, total: pageCount })}
          </span>
        ) : null}
        <button
          aria-label={t('pagination.nextPage')}
          className="admin-button admin-button-secondary"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          type="button"
        >
          {t('pagination.next')}
        </button>
      </div>

      {compact ? (
        <span aria-live="polite" className="text-center text-sm tabular-nums text-[color:var(--tx2)]">
          {t('pagination.pageOf', { page: page + 1, total: pageCount })}
        </span>
      ) : null}

      <div className={compact
        ? 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2'
        : 'flex flex-wrap items-center justify-end gap-x-4 gap-y-2'}
      >
        <span className="text-xs tabular-nums text-[color:var(--tx3)]">{label}</span>
        <label className="flex items-center gap-2 text-xs text-[color:var(--tx2)]">
          <span>{t('pagination.itemsPerPage')}</span>
          <Select
            aria-label={t('pagination.itemsPerPage')}
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
