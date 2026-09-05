import { useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
import { usePagedList } from '../facades/pagination/usePagedList'
import { workflowKeys } from '../lib/query-keys'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { useIsOwner } from '../facades/auth/hooks'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { WorkflowFailedRunsColumn } from '../components/features/workflows/WorkflowFailedRunsColumn'
import { WorkflowsListColumn } from '../components/features/workflows/WorkflowsListColumn'
import { WorkflowInstallationDetail } from '../components/features/workflows/WorkflowInstallationDetail'
import { WorkflowRunDetail } from '../components/features/workflows/WorkflowRunDetail'
import { WorkflowTemplateDetail } from '../components/features/workflows/WorkflowTemplateDetail'
import { DemonstrationDraftsColumn } from '../components/features/workflows/DemonstrationDraftsColumn'

/**
 * Workflows page. One list — the workflow templates — with drill-down:
 * workflow → installation → run. Installations are subordinate to their
 * workflow instead of a parallel top-level list of UUIDs.
 *
 * Selection and search are URL state (`?search=&template=&installation=&run=
 * &failedRuns=1&demonstrationDrafts=1`), not `useState`/`location.state`: the
 * registry declares this route family's filters linkable
 * (`navigation/admin-surfaces.ts`'s `/agents/(?:workflows|…)` row), and a
 * selection that only lived in component state could not be bookmarked,
 * shared, or survive a refresh (docs/plans/2026-09-05-admin-architecture-review/audit/05-pages-routing.md F5).
 */

const readParam = (searchParams: URLSearchParams, key: string): string | undefined =>
  searchParams.get(key) ?? undefined

export const WorkflowsPage = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const isWorkflowAdmin =
    isOwner || (me?.user.roleIds.includes('admin') ?? false)

  const [searchParams, setSearchParams] = useSearchParams()
  const searchQuery = searchParams.get('search') ?? ''
  const selectedTemplateId = readParam(searchParams, 'template')
  const selectedInstallationId = readParam(searchParams, 'installation')
  const selectedRunId = readParam(searchParams, 'run')
  const showFailedRuns = searchParams.get('failedRuns') === '1'
  const showDemonstrationDrafts = searchParams.get('demonstrationDrafts') === '1'

  // One writer for every param this screen owns, so a selection that touches
  // several of them (choosing a template drops its installation and run) is
  // one replace, not a race between three.
  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const setSearchQuery = (value: string) => updateParams({ search: value || null })
  const setSelectedRunId = (id: string | undefined) => updateParams({ run: id ?? null })
  const setShowFailedRuns = (value: boolean) => updateParams({ failedRuns: value ? '1' : null })
  const setShowDemonstrationDrafts = (value: boolean) =>
    updateParams({ demonstrationDrafts: value ? '1' : null })

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

  const selectTemplate = (template: WorkflowTemplateRecord) => {
    updateParams({ installation: null, run: null, template: template.id })
  }

  // The designer's own return address: a plain path this page can restore
  // from on the way back, since the selection lives in the URL rather than
  // `location.state` a round trip through the designer would otherwise have
  // to carry.
  const workflowsReturnPath = useMemo(() => {
    const params = new URLSearchParams()
    if (searchQuery) params.set('search', searchQuery)
    if (selectedTemplate?.id) params.set('template', selectedTemplate.id)
    if (selectedInstallationId) params.set('installation', selectedInstallationId)
    if (selectedRunId) params.set('run', selectedRunId)
    const query = params.toString()
    return `/agents/workflows${query ? `?${query}` : ''}`
  }, [searchQuery, selectedInstallationId, selectedRunId, selectedTemplate])

  const columns = []

  if (showFailedRuns) {
    columns.push(
      <WorkflowFailedRunsColumn
        failedRuns={failedRuns}
        failedRunsList={failedRunsList}
        key="failed-runs"
        onBack={() => setShowFailedRuns(false)}
        onSelectRun={(run) =>
          updateParams({ failedRuns: null, installation: run.installationId, run: run.id })
        }
      />,
    )
  }

  if (showDemonstrationDrafts) {
    columns.push(
      <DemonstrationDraftsColumn
        demonstrations={demonstrations}
        key="demonstration-drafts"
        onBack={() => setShowDemonstrationDrafts(false)}
        onReview={(workflowTemplateId) =>
          updateParams({
            demonstrationDrafts: null,
            installation: null,
            run: null,
            template: workflowTemplateId,
          })
        }
      />,
    )
  }

  columns.push(
    <WorkflowsListColumn
      demonstrations={demonstrations}
      failedRunsCount={failedRuns.length}
      filteredTemplates={filteredTemplates}
      isWorkflowAdmin={isWorkflowAdmin}
      key="workflows"
      onImported={(template) =>
        updateParams({ installation: null, run: null, template: template.id })
      }
      onNewWorkflow={() =>
        void navigate('/agents/workflow-designer', {
          state: { returnTo: workflowsReturnPath },
        })
      }
      onSelectTemplate={selectTemplate}
      onShowDemonstrationDrafts={() => setShowDemonstrationDrafts(true)}
      onShowFailedRuns={() => setShowFailedRuns(true)}
      searchQuery={searchQuery}
      selectedTemplateId={selectedTemplate?.id}
      setSearchQuery={setSearchQuery}
      sortedTemplatesCount={sortedTemplates.length}
      templatesList={templatesList}
    />,
  )

  if (selectedTemplate) {
    columns.push(
      <ColumnBrowserColumn
        key={`template-${selectedTemplate.id}`}
        onBack={() => updateParams({ template: null })}
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
                  updateParams({ installation: installation.id, run: null })
                },
              },
            )
          }
          onEdit={() =>
            void navigate(`/agents/workflow-designer/${selectedTemplate.id}`, {
              state: { returnTo: `/agents/workflows?template=${selectedTemplate.id}` },
            })
          }
          onSelectInstallation={(installationId) =>
            updateParams({
              installation: installationId === selectedInstallationId ? null : installationId,
              run: null,
            })
          }
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
        onBack={() => updateParams({ installation: null, run: null })}
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
