import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import type {
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowTemplateRecord,
} from '../lib/api-client'
import { useInstallWorkflowTemplate } from '../facades/workflows/hooks'
import {
  useDemonstrations,
} from '../facades/demonstrations/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { usePagedList } from '../facades/usePagedList'
import { workflowKeys } from '../lib/query-keys'
import { Pill } from '../components/primitives/Pill'
import { Skeleton } from '../components/primitives/Skeleton'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { useIsOwner } from '../components/shared/OwnerGate'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { Row, RowList } from '../components/shared/RowList'
import { WorkflowInstallationDetail } from '../components/features/workflows/WorkflowInstallationDetail'
import { WorkflowRunDetail } from '../components/features/workflows/WorkflowRunDetail'
import { WorkflowTemplateDetail } from '../components/features/workflows/WorkflowTemplateDetail'
import { WorkflowImportButton } from '../components/features/workflows/WorkflowImportButton'
import { DemonstrationDraftsColumn } from '../components/features/workflows/DemonstrationDraftsColumn'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import {
  formatRelativeTime,
  formatTimestamp,
  getRunTone,
} from '../components/features/workflows/presentation'

/**
 * Workflows page. One list — the workflow templates — with drill-down:
 * workflow → installation → run. Installations are subordinate to their
 * workflow instead of a parallel top-level list of UUIDs.
 */

type WorkflowsPageLocationState = {
  selectedInstallationId?: string
  selectedRunId?: string
  selectedTemplateId?: string
}

const readWorkflowsPageLocationState = (
  value: unknown,
): WorkflowsPageLocationState => {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const state = value as WorkflowsPageLocationState
  return {
    selectedInstallationId:
      typeof state.selectedInstallationId === 'string'
        ? state.selectedInstallationId
        : undefined,
    selectedRunId:
      typeof state.selectedRunId === 'string' ? state.selectedRunId : undefined,
    selectedTemplateId:
      typeof state.selectedTemplateId === 'string'
        ? state.selectedTemplateId
        : undefined,
  }
}

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

export const WorkflowsPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const isWorkflowAdmin =
    isOwner || (me?.user.roleIds.includes('admin') ?? false)
  // W19: template authoring stays admin-gated; the member-facing read surface
  // is the installations list (entitlement-scoped server-side) plus the
  // failed-runs triage view.
  const templatesList = usePagedList<WorkflowTemplateRecord>({
    enabled: isWorkflowAdmin,
    paramPrefix: 'templates-',
    path: '/api/workflows',
    queryKey: workflowKeys.templates,
  })
  const templates = templatesList.items
  const failedRunsList = usePagedList<WorkflowRunRecord>({
    params: { status: 'failed' },
    paramPrefix: 'failed-runs-',
    path: '/api/workflow-runs',
    queryKey: workflowKeys.failedRuns,
  })
  const failedRuns = failedRunsList.items
  const installWorkflowTemplate = useInstallWorkflowTemplate()
  const { data: demonstrations = [] } = useDemonstrations()
  const restoredSelection = useMemo(
    () => readWorkflowsPageLocationState(location.state),
    [location.state],
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(
    () => restoredSelection.selectedTemplateId,
  )
  const [selectedInstallationId, setSelectedInstallationId] = useState<
    string | undefined
  >(() => restoredSelection.selectedInstallationId)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    () => restoredSelection.selectedRunId,
  )

  // Installations are read for the selected template only, through the
  // endpoint's `workflowTemplateId` filter. The page used to fetch the
  // organisation's whole installation set and group it in the browser to
  // serve both this pane and the per-row counts; the counts now come from the
  // template record's server-side aggregate, so nothing needs the cross-
  // template set and this asks a question the size of the answer.
  const installationsList = usePagedList<WorkflowInstallationRecord>({
    enabled: Boolean(selectedTemplateId),
    params: { workflowTemplateId: selectedTemplateId },
    paramPrefix: 'installations-',
    path: '/api/workflow-installations',
    queryKey: workflowKeys.installations,
  })
  const installations = installationsList.items
  // W29: the triage surface — one cross-installation answer to "what broke
  // last night". Opens straight onto the failed run's detail.
  const [showFailedRuns, setShowFailedRuns] = useState(false)
  const [showDemonstrationDrafts, setShowDemonstrationDrafts] = useState(false)

  useEffect(() => {
    if (
      isWorkflowAdmin
      && demonstrations.some((demonstration) =>
        demonstration.workflowTemplateId
        && !templates.some((template) => template.id === demonstration.workflowTemplateId),
      )
    ) {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.templates })
    }
  }, [demonstrations, isWorkflowAdmin, queryClient, templates])

  const sortedTemplates = useMemo(
    () =>
      [...templates].sort((left, right) => left.name.localeCompare(right.name)),
    [templates],
  )

  // Newest first, as the detail pane renders them. No grouping by template
  // any more — the query is already scoped to one.
  const selectedTemplateInstallations = useMemo(
    () =>
      [...installations].sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [installations],
  )

  const filteredTemplates = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return sortedTemplates
    return sortedTemplates.filter(
      (template) =>
        template.name.toLowerCase().includes(query) ||
        (template.description ?? '').toLowerCase().includes(query),
    )
  }, [searchQuery, sortedTemplates])

  const effectiveTemplateId =
    selectedTemplateId &&
    sortedTemplates.some((template) => template.id === selectedTemplateId)
      ? selectedTemplateId
      : filteredTemplates[0]?.id

  const selectedTemplate = useMemo(
    () => sortedTemplates.find((template) => template.id === effectiveTemplateId),
    [effectiveTemplateId, sortedTemplates],
  )

  const selectedInstallation = useMemo(
    () =>
      selectedInstallationId
        ? installations.find((entry) => entry.id === selectedInstallationId)
        : undefined,
    [installations, selectedInstallationId],
  )

  // Restore selection handed back from the designer; an installation-only
  // state also selects its parent workflow so the drill-down stays coherent.
  useEffect(() => {
    if (restoredSelection.selectedTemplateId) {
      setSelectedTemplateId(restoredSelection.selectedTemplateId)
    }
    if (restoredSelection.selectedInstallationId) {
      setSelectedInstallationId(restoredSelection.selectedInstallationId)
      const parent = installations.find(
        (entry) => entry.id === restoredSelection.selectedInstallationId,
      )
      if (parent) setSelectedTemplateId(parent.workflowTemplateId)
    }
    if (restoredSelection.selectedRunId) {
      setSelectedRunId(restoredSelection.selectedRunId)
    }
  }, [installations, restoredSelection])

  const currentWorkflowLocationState: WorkflowsPageLocationState = {
    selectedTemplateId: selectedTemplate?.id,
    selectedInstallationId,
    selectedRunId,
  }

  const selectTemplate = (template: WorkflowTemplateRecord) => {
    setSelectedTemplateId(template.id)
    setSelectedInstallationId(undefined)
    setSelectedRunId(undefined)
  }

  const columns = []

  if (showFailedRuns) {
    columns.push(
      <ColumnBrowserColumn
        key="failed-runs"
        onBack={() => setShowFailedRuns(false)}
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
                    onClick={() => {
                      setSelectedRunId(run.id)
                      setSelectedInstallationId(run.installationId)
                      setShowFailedRuns(false)
                    }}
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
      </ColumnBrowserColumn>,
    )
  }

  if (showDemonstrationDrafts) {
    columns.push(
      <DemonstrationDraftsColumn
        demonstrations={demonstrations}
        key="demonstration-drafts"
        onBack={() => setShowDemonstrationDrafts(false)}
        onReview={(workflowTemplateId) => {
          setSelectedTemplateId(workflowTemplateId)
          setSelectedInstallationId(undefined)
          setSelectedRunId(undefined)
          setShowDemonstrationDrafts(false)
        }}
      />,
    )
  }

  columns.push(
    <ColumnBrowserColumn
      leading={<PhoneNavigationButton />}
      headerAction={
        isWorkflowAdmin ? (
          <button
            className="admin-button admin-button-primary"
            onClick={() =>
              void navigate('/agents/workflow-designer', {
                state: {
                  returnTo: '/agents/workflows',
                  returnToState: currentWorkflowLocationState,
                },
              })
            }
            type="button"
          >
            New workflow
          </button>
        ) : undefined
      }
      key="workflows"
      title={`Workflows (${templatesList.total ?? sortedTemplates.length})`}
    >
      <button
        className="mb-3 flex w-full items-center justify-between rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2 text-left hover:bg-[var(--overlay-weak)]"
        data-testid="failed-runs-toggle"
        onClick={() => setShowFailedRuns(true)}
        type="button"
      >
        <span className="text-sm font-medium text-[var(--tx)]">
          What failed?
        </span>
        <Pill tone={failedRuns.length > 0 ? 'danger' : 'muted'}>
          {failedRuns.length} failed
        </Pill>
      </button>
      <button
        className="mb-3 flex w-full items-center justify-between rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2 text-left hover:bg-[var(--overlay-weak)]"
        data-testid="demonstration-drafts-toggle"
        onClick={() => setShowDemonstrationDrafts(true)}
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
          <WorkflowImportButton
            onImported={(template) => {
              setSelectedTemplateId(template.id)
              setSelectedInstallationId(undefined)
              setSelectedRunId(undefined)
            }}
          />
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
              sortedTemplates.length === 0
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
                        onClick={() => selectTemplate(template)}
                        selected={template.id === selectedTemplate?.id}
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
    </ColumnBrowserColumn>,
  )

  if (selectedTemplate) {
    columns.push(
      <ColumnBrowserColumn
        key={`template-${selectedTemplate.id}`}
        onBack={() => setSelectedTemplateId(undefined)}
        showBack
        title={selectedTemplate.name}
      >
        <WorkflowTemplateDetail
          installations={selectedTemplateInstallations}
          isInstalling={installWorkflowTemplate.isPending}
          onInstall={() =>
            installWorkflowTemplate.mutate(
              { workflowTemplateId: selectedTemplate.id },
              {
                onSuccess: (installation) => {
                  setSelectedInstallationId(installation.id)
                  setSelectedRunId(undefined)
                },
              },
            )
          }
          onEdit={() =>
            void navigate(`/agents/workflow-designer/${selectedTemplate.id}`, {
              state: {
                returnTo: '/agents/workflows',
                returnToState: {
                  selectedTemplateId: selectedTemplate.id,
                },
              },
            })
          }
          onSelectInstallation={(installationId) => {
            setSelectedInstallationId(
              installationId === selectedInstallationId ? undefined : installationId,
            )
            setSelectedRunId(undefined)
          }}
          selectedInstallationId={selectedInstallation?.id}
          template={selectedTemplate}
        />
      </ColumnBrowserColumn>,
    )
  }

  if (selectedInstallation) {
    columns.push(
      <ColumnBrowserColumn
        key={`installation-${selectedInstallation.id}`}
        onBack={() => {
          setSelectedInstallationId(undefined)
          setSelectedRunId(undefined)
        }}
        showBack
        title={`Installation ${selectedInstallation.id.slice(0, 8)}`}
      >
        <WorkflowInstallationDetail
          installation={selectedInstallation}
          onSelectRun={setSelectedRunId}
          selectedRunId={selectedRunId}
          template={sortedTemplates.find(
            (template) => template.id === selectedInstallation.workflowTemplateId,
          )}
          templates={sortedTemplates}
        />
      </ColumnBrowserColumn>,
    )
  }

  if (selectedInstallation && selectedRunId) {
    columns.push(
      <ColumnBrowserColumn
        key={`run-${selectedRunId}`}
        onBack={() => setSelectedRunId(undefined)}
        showBack
        title={`Run ${selectedRunId.slice(0, 8)}`}
      >
        <WorkflowRunDetail workflowRunId={selectedRunId} />
      </ColumnBrowserColumn>,
    )
  }

  const activeColumn = selectedRunId && selectedInstallation
    ? 3
    : selectedInstallation
      ? 2
      : selectedTemplate && selectedTemplateId
        ? 1
        : 0

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={activeColumn} columns={columns} />
    </div>
  )
}
