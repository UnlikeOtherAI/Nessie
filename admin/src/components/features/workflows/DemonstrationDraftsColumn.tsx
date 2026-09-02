import { useGeneralizeDemonstration, type DemonstrationRecord } from '../../../facades/demonstrations/hooks'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { EmptyState } from '../../shared/EmptyState'
import { FormError } from '../../shared/FormActions'
import { Row, RowList } from '../../shared/RowList'
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
        <EmptyState>
          No recorded routines yet. Record one from its channel when work is happening.
        </EmptyState>
      ) : (
        <RowList label="Demonstrations">
          {demonstrations.map((demonstration) => (
            <Row
              key={demonstration.id}
              title={
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    Routine with {demonstration.stepCount} captured step
                    {demonstration.stepCount === 1 ? '' : 's'}
                  </span>
                  <Pill
                    height="control"
                    tone={demonstration.status === 'generalized' ? 'success' : 'warning'}
                  >
                    {demonstration.status === 'generalized' ? 'Draft ready' : demonstration.status}
                  </Pill>
                </span>
              }
              trailing={
                demonstration.workflowTemplateId ? (
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
                ) : null
              }
              subtitle={
                formatRelativeTime(demonstration.capturedAt ?? demonstration.startedAt)
                ?? formatTimestamp(demonstration.startedAt)
              }
            >
              {demonstration.generalizationError ? (
                <FormError className="mt-1">{demonstration.generalizationError}</FormError>
              ) : null}
            </Row>
          ))}
        </RowList>
      )}
    </ColumnBrowserColumn>
  )
}
