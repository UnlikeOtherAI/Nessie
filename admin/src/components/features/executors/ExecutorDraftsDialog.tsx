import { useState } from 'react'
import type { ExecutorRecordResponse } from '@nessie/schemas'
import {
  useMyExecutorWorkspaceReviews,
  usePrepareExecutorWorkspacePromotion,
} from '../../../facades/executors/hooks'
import { Dialog } from '../../shared/Dialog'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'

export type PreparedExecutorPromotion = {
  confirmationToken: string
  executorId: string
  promotionId: string
}

type ExecutorDraftsDialogProps = {
  /** Names the executor each draft came from, where it is one this viewer can see. */
  executors: ExecutorRecordResponse[]
  onClose: () => void
  /** The dialog closes and hands the prepared promotion to its own confirmation. */
  onPrepared: (prepared: PreparedExecutorPromotion) => void
  open: boolean
}

/**
 * A person's own COW reviews are the doorway to a separately confirmed host
 * write. They are not a property of any one executor — they belong to the runs
 * *you* started — so they are reached from the Computers header rather than
 * being filtered onto one executor's detail page, where a draft from a machine
 * you can no longer see would have had nowhere to appear.
 */
export const ExecutorDraftsDialog = ({
  executors,
  onClose,
  onPrepared,
  open,
}: ExecutorDraftsDialogProps) => {
  const reviewsQuery = useMyExecutorWorkspaceReviews()
  const prepare = usePrepareExecutorWorkspacePromotion()
  const [error, setError] = useState<string | null>(null)
  const reviews = reviewsQuery.data ?? []
  const executorNames = new Map(executors.map((executor) => [executor.id, executor.label]))

  const preparePromotion = async (reviewCommandId: string) => {
    setError(null)
    try {
      onPrepared(await prepare.mutateAsync({ reviewCommandId }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to prepare workspace promotion.')
    }
  }

  return (
    <Dialog
      description="Only drafts from runs you started appear here. Preparing a promotion opens a separate, password-confirmed review; it never writes the host workspace by itself."
      onClose={() => {
        setError(null)
        onClose()
      }}
      open={open}
      size="lg"
      title="Your reviewed drafts"
    >
      <div className="grid gap-3">
        <FormError>{error}</FormError>
        <QueryState
          className="py-6"
          emptyLabel="No reviewed drafts are ready to promote."
          errorLabel="Your reviewed drafts could not be loaded."
          isEmpty={reviews.length === 0}
          loadingLabel="Loading your reviewed drafts…"
          query={reviewsQuery}
        >
          {() => (
            <RowList label="Your reviewed drafts">
              {reviews.map((review) => (
                <Row
                  key={review.commandId}
                  subtitle={`Reviewed ${review.acknowledgedAt}`}
                  title={
                    `${executorNames.get(review.executorId) ?? 'Paired computer'} · `
                    + `${review.changes.length} change${review.changes.length === 1 ? '' : 's'}`
                  }
                  trailing={
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={prepare.isPending}
                      onClick={() => void preparePromotion(review.commandId)}
                      type="button"
                    >
                      {prepare.isPending && prepare.variables?.reviewCommandId === review.commandId
                        ? 'Preparing…'
                        : 'Review promotion'}
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
      </div>
    </Dialog>
  )
}
