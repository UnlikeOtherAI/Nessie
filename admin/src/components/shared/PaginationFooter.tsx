type PaginationFooterProps = {
  canNext: boolean
  canPrevious: boolean
  /** Spacing only — the border and the three-slot layout are not negotiable. */
  className?: string
  /**
   * Render nothing when neither direction is reachable, i.e. the list fits on
   * one page. Off by default: a footer that always shows keeps the row height
   * of a table stable as its pages change.
   */
  hideWhenSinglePage?: boolean
  label: string
  onPageChange: (page: number) => void
  page: number
}

/**
 * The Previous / label / Next strip that closes a paged list.
 *
 * It is presentational and nothing more. **How a caller gets its pages is
 * deliberately not shared**: `AgentsList` slices an array it already holds,
 * while `AgentDetailTabs` asks the server for `PAGE_SIZE + 1` rows to learn
 * whether a next page exists at all. Those are different problems with
 * different failure modes, and a single "usePagination" hook over both would
 * only be able to serve them by branching on which one it was given. So each
 * caller keeps its own arithmetic and hands over the two booleans and the one
 * string that arithmetic produced — `page` is passed back untouched, purely so
 * the strip can ask for `page - 1` / `page + 1` without caring whether the
 * caller counts from zero or one.
 *
 * The label is a caller string for the same reason: "1–10 of 34 · Page 1 of 4"
 * and a bare "Page 1" are true statements about different amounts of
 * knowledge, and the strip is not the thing that knows which applies.
 */
export const PaginationFooter = ({
  canNext,
  canPrevious,
  className,
  hideWhenSinglePage = false,
  label,
  onPageChange,
  page,
}: PaginationFooterProps) => {
  if (hideWhenSinglePage && !canPrevious && !canNext) return null

  return (
    <div
      className={[
        'flex items-center justify-between border-t border-[color:var(--sep)]',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        className="admin-button admin-button-secondary"
        disabled={!canPrevious}
        onClick={() => onPageChange(page - 1)}
        type="button"
      >
        Previous
      </button>
      <span className="text-xs text-[color:var(--tx3)]">{label}</span>
      <button
        className="admin-button admin-button-secondary"
        disabled={!canNext}
        onClick={() => onPageChange(page + 1)}
        type="button"
      >
        Next
      </button>
    </div>
  )
}
