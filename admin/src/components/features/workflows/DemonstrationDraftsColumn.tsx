import { useGeneralizeDemonstration, type DemonstrationRecord } from '../../../facades/demonstrations/hooks'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { Pill } from '../../primitives/Pill'

import { formatRelativeTime, formatTimestamp } from './presentation'

type DemonstrationDraftsColumnProps = {
  demonstrations: DemonstrationRecord[]
  onBack: () => void
  onReview: (workflowTemplateId: string) => void
}

/** A doorway into the ordinary Workflow review surface, not a second library. */
export const DemonstrationDraftsColumn = ({
  demonstrations,
  onBack,
  onReview,
}: DemonstrationDraftsColumnProps) => {
  const generalizeDemonstration = useGeneralizeDemonstration()

  return (
    <ColumnBrowserColumn
      onBack={onBack}
      showBack
      title={`Demonstrations (${demonstrations.length})`}
    >
      {demonstrations.length === 0 ? (
        <div className="py-10 text-center text-sm text-[color:var(--tx3)]">
          No recorded routines yet. Record one from its channel when work is happening.
        </div>
      ) : (
        <div className="divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
          {demonstrations.map((demonstration) => (
            <div className="grid gap-2 px-3 py-3" key={demonstration.id}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--tx)]">
                  Routine with {demonstration.stepCount} captured step{demonstration.stepCount === 1 ? '' : 's'}
                </span>
                <Pill tone={demonstration.status === 'generalized' ? 'success' : 'warning'}>
                  {demonstration.status === 'generalized' ? 'Draft ready' : demonstration.status}
                </Pill>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-[color:var(--tx3)]">
                <span>
                  {formatRelativeTime(demonstration.capturedAt ?? demonstration.startedAt)
                    ?? formatTimestamp(demonstration.startedAt)}
                </span>
                {demonstration.workflowTemplateId ? (
                  <button
                    className="admin-button admin-button-secondary"
                    onClick={() => onReview(demonstration.workflowTemplateId!)}
                    type="button"
                  >
                    Review draft
                  </button>
                ) : demonstration.status === 'captured' && !demonstration.generalizationError ? (
                  <button
                    className="admin-button admin-button-primary"
                    disabled={generalizeDemonstration.isPending}
                    onClick={() => void generalizeDemonstration.mutate(demonstration.id)}
                    type="button"
                  >
                    Generalise → draft Workflow
                  </button>
                ) : null}
              </div>
              {demonstration.generalizationError ? (
                <p className="text-xs text-[color:var(--danger)]">
                  {demonstration.generalizationError}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </ColumnBrowserColumn>
  )
}
