import type {
  ExecutorRecordResponse,
  OriginatingExecutorWorkspaceReviewRecordResponse,
} from '@nessie/schemas'

type ExecutorWorkspacePromotionsPanelProps = {
  isError: boolean
  isLoading: boolean
  onPrepare: (reviewCommandId: string) => void
  preparingReviewId?: string
  reviews: OriginatingExecutorWorkspaceReviewRecordResponse[]
  executors: ExecutorRecordResponse[]
}

/** A person's own COW reviews are the doorway to a separately confirmed host write. */
export const ExecutorWorkspacePromotionsPanel = ({
  executors,
  isError,
  isLoading,
  onPrepare,
  preparingReviewId,
  reviews,
}: ExecutorWorkspacePromotionsPanelProps) => {
  const executorNames = new Map(executors.map((executor) => [executor.id, executor.label]))
  return (
    <section className="admin-card grid gap-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-[color:var(--tx)]">Your reviewed drafts</h2>
        <p className="mt-1 text-xs text-[color:var(--tx3)]">
          Only drafts from runs you started appear here. Preparing a promotion opens a separate,
          password-confirmed review; it never writes the host workspace by itself.
        </p>
      </div>
      {isLoading ? <p className="text-sm text-[color:var(--tx3)]">Loading your reviewed drafts…</p> : null}
      {isError ? <p className="text-sm text-[color:var(--danger-text)]">Unable to load your reviewed drafts.</p> : null}
      {!isLoading && !isError && reviews.length === 0 ? <p className="text-sm text-[color:var(--tx3)]">No reviewed drafts are ready to promote.</p> : null}
      <div className="grid gap-2">
        {!isError && reviews.map((review) => (
          <article className="rounded-md border border-[color:var(--border)] p-3" key={review.commandId}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[color:var(--tx)]">
                  {executorNames.get(review.executorId) ?? 'Paired executor'} · {review.changes.length} change{review.changes.length === 1 ? '' : 's'}
                </p>
                <p className="mt-1 text-xs text-[color:var(--tx3)]">Reviewed {review.acknowledgedAt}</p>
                <code className="mt-1 block truncate text-[11px] text-[color:var(--tx3)]">{review.manifestDigest}</code>
              </div>
              <button
                className="admin-button admin-button-secondary"
                disabled={preparingReviewId === review.commandId}
                onClick={() => onPrepare(review.commandId)}
                type="button"
              >
                {preparingReviewId === review.commandId ? 'Preparing…' : 'Review promotion'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
