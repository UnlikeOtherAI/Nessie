import { useEffect } from 'react'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import type { FeedbackRecord } from '../../lib/api-client'

const FEEDBACK_PAGE_SIZE = 5

const STATUS_LABELS: Record<string, string> = {
  saved: 'Recorded',
  submitted: 'Sent to GitHub',
  failed: 'Send failed',
}

const formatDate = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

const StatusChip = ({ status }: { status: string }) => {
  const label = STATUS_LABELS[status] ?? status
  const tone =
    status === 'failed'
      ? 'text-[color:var(--danger-text)]'
      : status === 'submitted'
        ? 'text-[color:var(--accent)]'
        : 'text-[color:var(--tx3)]'
  return <span className={`text-xs font-semibold ${tone}`}>{label}</span>
}

export const getFeedbackPage = <Item,>(items: Item[], page: number) => {
  const totalPages = Math.max(1, Math.ceil(items.length / FEEDBACK_PAGE_SIZE))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const firstItemIndex = (currentPage - 1) * FEEDBACK_PAGE_SIZE

  return {
    currentPage,
    items: items.slice(firstItemIndex, firstItemIndex + FEEDBACK_PAGE_SIZE),
    totalPages,
  }
}

export const FeedbackList = ({
  items,
  isLoading,
  onPageChange,
  page,
}: {
  items: FeedbackRecord[]
  isLoading: boolean
  onPageChange: (page: number) => void
  page: number
}) => {
  const { currentPage, items: pageItems, totalPages } = getFeedbackPage(items, page)

  useEffect(() => {
    if (currentPage !== page) onPageChange(currentPage)
  }, [currentPage, onPageChange, page])

  return (
    <section className="admin-card w-full p-4">
      <SectionLabel>Your feedback</SectionLabel>

      {isLoading ? (
        <div className="mt-3 text-sm text-[color:var(--tx2)]">Loading…</div>
      ) : items.length === 0 ? (
        <div className="mt-3 text-sm text-[color:var(--tx2)]">
          You haven&apos;t sent any feedback yet.
        </div>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {pageItems.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="font-semibold text-[color:var(--tx)]">{item.title}</div>
                  <StatusChip status={item.status} />
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-[color:var(--tx2)]">
                  {item.body}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[color:var(--tx3)]">
                  <span>{formatDate(item.createdAt)}</span>
                  {item.attachmentFilename && (
                    <span>📎 {item.attachmentFilename}</span>
                  )}
                  {item.githubIssueUrl && (
                    <a
                      className="text-[color:var(--lnk)] hover:underline"
                      href={item.githubIssueUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View issue{item.githubIssueNumber ? ` #${item.githubIssueNumber}` : ''}
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3 text-sm">
              <span className="text-[color:var(--tx3)]">
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  className="admin-button admin-button-secondary"
                  disabled={currentPage === 1}
                  onClick={() => onPageChange(currentPage - 1)}
                  type="button"
                >
                  Previous
                </button>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={currentPage === totalPages}
                  onClick={() => onPageChange(currentPage + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
