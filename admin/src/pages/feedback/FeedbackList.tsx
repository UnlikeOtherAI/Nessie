import type { FeedbackRecord } from '../../lib/api-client'
import { sectionTitleClass } from '../settings/settings-shared'

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

export const FeedbackList = ({
  items,
  isLoading,
}: {
  items: FeedbackRecord[]
  isLoading: boolean
}) => {
  return (
    <section className="admin-card max-w-3xl p-4">
      <div className={sectionTitleClass}>Your feedback</div>

      {isLoading ? (
        <div className="mt-3 text-sm text-[color:var(--tx2)]">Loading…</div>
      ) : items.length === 0 ? (
        <div className="mt-3 text-sm text-[color:var(--tx2)]">
          You haven&apos;t sent any feedback yet.
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
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
      )}
    </section>
  )
}
