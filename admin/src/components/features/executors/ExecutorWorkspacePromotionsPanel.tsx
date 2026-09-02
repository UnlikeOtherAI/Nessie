import type {
  ExecutorRecordResponse,
  OriginatingExecutorWorkspaceReviewRecordResponse,
} from '@nessie/schemas'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'

type ExecutorWorkspacePromotionsPanelProps = {
  isError: boolean
  isLoading: boolean
  onPrepare: (reviewCommandId: string) => void
  preparingReviewId?: string
  refetch: () => unknown
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
  refetch,
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
      <QueryState
        className="py-6"
        emptyLabel="No reviewed drafts are ready to promote."
        errorLabel="Your reviewed drafts could not be loaded."
        isEmpty={reviews.length === 0}
        loadingLabel="Loading your reviewed drafts…"
        query={{ isError, isLoading, refetch }}
      >
        {() => (
          <RowList label="Your reviewed drafts">
            {reviews.map((review) => (
              <Row
                key={review.commandId}
                subtitle={`Reviewed ${review.acknowledgedAt}`}
                title={
                  `${executorNames.get(review.executorId) ?? 'Paired executor'} · `
                  + `${review.changes.length} change${review.changes.length === 1 ? '' : 's'}`
                }
                trailing={
                  <button
                    className="admin-button admin-button-secondary"
                    disabled={preparingReviewId === review.commandId}
                    onClick={() => onPrepare(review.commandId)}
                    type="button"
                  >
                    {preparingReviewId === review.commandId ? 'Preparing…' : 'Review promotion'}
                  </button>
                }
              >
                <code className="mt-0.5 block truncate text-[11px] text-[color:var(--tx3)]">
                  {review.manifestDigest}
                </code>
              </Row>
            ))}
          </RowList>
        )}
      </QueryState>
    </section>
  )
}
