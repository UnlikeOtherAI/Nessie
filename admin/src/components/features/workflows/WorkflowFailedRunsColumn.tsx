import type { WorkflowRunRecord } from '../../../lib/api-client'
import type { PagedList } from '../../../facades/usePagedList'
import { Pill } from '../../primitives/Pill'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { formatRelativeTime, formatTimestamp, getRunTone } from './presentation'

type WorkflowFailedRunsColumnProps = {
  failedRuns: WorkflowRunRecord[]
  failedRunsList: PagedList<WorkflowRunRecord>
  onBack: () => void
  onSelectRun: (run: WorkflowRunRecord) => void
}

/** W29's triage surface — one cross-installation answer to "what broke last
 *  night". Opens straight onto the failed run's detail. */
export const WorkflowFailedRunsColumn = ({
  failedRuns,
  failedRunsList,
  onBack,
  onSelectRun,
}: WorkflowFailedRunsColumnProps) => (
  <ColumnBrowserColumn
    key="failed-runs"
    onBack={onBack}
    showBack
    title={`Failed runs (${failedRunsList.total ?? failedRuns.length})`}
  >
    <QueryState
      emptyLabel="No failed runs — nothing broke."
      errorLabel="Failed runs could not be loaded."
      isEmpty={failedRuns.length === 0}
      loadingLabel="Loading failed runs…"
      query={failedRunsList.query}
    >
      {() => (
        <>
          <RowList label="Failed runs">
            {failedRuns.map((run) => (
              <Row
                key={run.id}
                onClick={() => onSelectRun(run)}
                subtitle={
                  `${run.errorMessage ?? run.summary ?? 'Failed'} · `
                  + `${formatRelativeTime(run.finishedAt ?? run.updatedAt)
                    ?? formatTimestamp(run.updatedAt)}`
                }
                title={
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      Run {run.id.slice(0, 8)}
                    </span>
                    <Pill height="control" tone={getRunTone(run.status)}>
                      {run.status}
                    </Pill>
                  </span>
                }
              />
            ))}
          </RowList>
          <PaginationFooter
            canNext={failedRunsList.canNext}
            canPrevious={failedRunsList.canPrevious}
            className="mt-3"
            hideWhenSinglePage
            label={failedRunsList.label}
            onPageChange={failedRunsList.onPageChange}
            onPageSizeChange={failedRunsList.onPageSizeChange}
            page={failedRunsList.page}
            pageCount={failedRunsList.pageCount}
            pageSize={failedRunsList.pageSize}
          />
        </>
      )}
    </QueryState>
  </ColumnBrowserColumn>
)
