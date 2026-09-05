import type { DemonstrationRecord } from '../../../facades/demonstrations/hooks'
import type { WorkflowTemplateRecord } from '../../../lib/api-client'
import type { PagedList } from '../../../facades/usePagedList'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { WorkflowImportButton } from './WorkflowImportButton'
import { formatRelativeTime, formatTimestamp } from './presentation'

/**
 * The badge beside a workflow on the list.
 *
 * It reads the server's aggregate rather than counting a page of rows the
 * browser happens to hold — which is what it did before, and which stopped
 * being true the moment list endpoints started returning 25 rows instead of
 * every row. An absent summary means the endpoint did not report one, which
 * is not the same as zero, so the badge says nothing rather than "draft".
 */
const summarizeInstallations = (
  summary: WorkflowTemplateRecord['installationSummary'],
): { label: string; tone: 'accent' | 'danger' | 'muted' | 'success' | 'warning' } | null => {
  if (!summary) return null
  if (summary.total === 0) return { label: 'draft', tone: 'muted' }
  if (summary.active > 0) {
    return {
      label: summary.active === summary.total ? 'active' : `${summary.active} of ${summary.total} active`,
      tone: 'success',
    }
  }
  return { label: `${summary.total} inactive`, tone: 'muted' }
}

type WorkflowsListColumnProps = {
  demonstrations: DemonstrationRecord[]
  failedRunsCount: number
  filteredTemplates: WorkflowTemplateRecord[]
  isWorkflowAdmin: boolean
  onImported: (template: WorkflowTemplateRecord) => void
  onNewWorkflow: () => void
  onSelectTemplate: (template: WorkflowTemplateRecord) => void
  onShowDemonstrationDrafts: () => void
  onShowFailedRuns: () => void
  searchQuery: string
  selectedTemplateId: string | undefined
  setSearchQuery: (value: string) => void
  sortedTemplatesCount: number
  templatesList: PagedList<WorkflowTemplateRecord>
}

/**
 * The route's own screen: the workflow templates list, with the two
 * cross-template drill-down doorways ("What failed?", "Demonstration
 * drafts") and the search field that narrows it.
 */
export const WorkflowsListColumn = ({
  demonstrations,
  failedRunsCount,
  filteredTemplates,
  isWorkflowAdmin,
  onImported,
  onNewWorkflow,
  onSelectTemplate,
  onShowDemonstrationDrafts,
  onShowFailedRuns,
  searchQuery,
  selectedTemplateId,
  setSearchQuery,
  sortedTemplatesCount,
  templatesList,
}: WorkflowsListColumnProps) => {
  const actions: PageHeaderAction[] | undefined = isWorkflowAdmin
    ? [
      {
        id: 'new-workflow',
        label: 'New workflow',
        onSelect: onNewWorkflow,
        primary: true,
        priority: 100,
      },
    ]
    : undefined

  return (
    <ColumnBrowserColumn
      actions={actions}
      key="workflows"
      screen
      title={`Workflows (${templatesList.total ?? sortedTemplatesCount})`}
    >
      <button
        className="mb-3 flex w-full items-center justify-between rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2 text-left hover:bg-[var(--overlay-weak)]"
        data-testid="failed-runs-toggle"
        onClick={onShowFailedRuns}
        type="button"
      >
        <span className="text-sm font-medium text-[var(--tx)]">
          What failed?
        </span>
        <Pill tone={failedRunsCount > 0 ? 'danger' : 'muted'}>
          {failedRunsCount} failed
        </Pill>
      </button>
      <button
        className="mb-3 flex w-full items-center justify-between rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2 text-left hover:bg-[var(--overlay-weak)]"
        data-testid="demonstration-drafts-toggle"
        onClick={onShowDemonstrationDrafts}
        type="button"
      >
        <span className="text-sm font-medium text-[var(--tx)]">Demonstration drafts</span>
        <Pill tone={demonstrations.some((entry) => entry.status === 'captured') ? 'warning' : 'muted'}>
          {demonstrations.length}
        </Pill>
      </button>
      <div className="grid gap-3">
        <div className="flex items-start gap-2">
          <input
            autoComplete="off"
            className="admin-input flex-1"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search workflows…"
            type="search"
            value={searchQuery}
          />
          <WorkflowImportButton onImported={onImported} />
        </div>
        {/* Search narrows only the loaded page: `/api/workflows` has no
            server-side text filter to page a search against, so paging past
            the first screen and searching are two different ways to reach
            more templates rather than one combined query.

            A list whose shape is already known shows that shape while it
            loads rather than the word Loading (docs/navigation/overview.md §14); the
            kit's QueryState still owns the error and empty lines. */}
        {templatesList.query.isLoading ? (
          <Skeleton className="py-4" count={4} variant="list" />
        ) : (
          <QueryState
            emptyLabel={
              sortedTemplatesCount === 0
                ? 'No workflows yet. Build one in the designer.'
                : 'No workflows match the search.'
            }
            errorLabel="Workflows could not be loaded."
            isEmpty={filteredTemplates.length === 0}
            loadingLabel="Loading workflows…"
            query={templatesList.query}
          >
            {() => (
              <>
                <RowList label="Workflows">
                  {filteredTemplates.map((template) => {
                    const summary = summarizeInstallations(template.installationSummary)

                    return (
                      <Row
                        key={template.id}
                        onClick={() => onSelectTemplate(template)}
                        selected={template.id === selectedTemplateId}
                        subtitle={
                          `v${template.version} · ${template.graph.steps.length} step`
                          + `${template.graph.steps.length === 1 ? '' : 's'}`
                          + (template.installationSummary?.total
                            ? ` · ${template.installationSummary.total} installation${
                                template.installationSummary.total === 1 ? '' : 's'
                              }`
                            : '')
                          + ' · '
                          + (formatRelativeTime(template.updatedAt)
                            ?? formatTimestamp(template.updatedAt))
                        }
                        title={
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">
                              {template.name}
                            </span>
                            {summary ? (
                              <Pill height="control" tone={summary.tone}>
                                {summary.label}
                              </Pill>
                            ) : null}
                            {template.source === 'demonstration' ? (
                              <Pill height="control" tone="accent">Learned</Pill>
                            ) : null}
                          </span>
                        }
                      />
                    )
                  })}
                </RowList>
                <PaginationFooter
                  canNext={templatesList.canNext}
                  canPrevious={templatesList.canPrevious}
                  className="mt-3"
                  hideWhenSinglePage
                  label={templatesList.label}
                  onPageChange={templatesList.onPageChange}
                  onPageSizeChange={templatesList.onPageSizeChange}
                  page={templatesList.page}
                  pageCount={templatesList.pageCount}
                  pageSize={templatesList.pageSize}
                />
              </>
            )}
          </QueryState>
        )}
      </div>
    </ColumnBrowserColumn>
  )
}
