import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type {
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../lib/api-client'
import {
  useInstallWorkflowTemplate,
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../facades/workflows/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { StatusPill } from '../components/primitives/StatusPill'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { WorkflowInstallationDetail } from '../components/features/workflows/WorkflowInstallationDetail'
import { WorkflowRunDetail } from '../components/features/workflows/WorkflowRunDetail'
import { WorkflowTemplateDetail } from '../components/features/workflows/WorkflowTemplateDetail'
import { WorkflowImportButton } from '../components/features/workflows/WorkflowImportButton'
import {
  formatRelativeTime,
  formatTimestamp,
  getInstallationTone,
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

const summarizeInstallations = (
  installations: WorkflowInstallationRecord[],
): { label: string; tone: 'accent' | 'danger' | 'muted' | 'success' | 'warning' } => {
  const latest = installations[0]
  if (!latest) return { label: 'draft', tone: 'muted' }
  if (installations.some((entry) => entry.status === 'active')) {
    return { label: 'active', tone: 'success' }
  }
  return { label: latest.status, tone: getInstallationTone(latest.status) }
}

export const WorkflowsPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: templates = [] } = useWorkflowTemplates(isOwner)
  const { data: installations = [] } = useWorkflowInstallations(isOwner)
  const installWorkflowTemplate = useInstallWorkflowTemplate()
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

  const sortedTemplates = useMemo(
    () =>
      [...templates].sort((left, right) => left.name.localeCompare(right.name)),
    [templates],
  )

  const installationsByTemplateId = useMemo(() => {
    const map = new Map<string, WorkflowInstallationRecord[]>()
    for (const installation of [...installations].sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )) {
      const bucket = map.get(installation.workflowTemplateId) ?? []
      bucket.push(installation)
      map.set(installation.workflowTemplateId, bucket)
    }
    return map
  }, [installations])

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

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

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

  const columns = [
    <ColumnBrowserColumn
      headerAction={
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
      }
      key="workflows"
      title={`Workflows (${sortedTemplates.length})`}
    >
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
        {filteredTemplates.length === 0 ? (
          <div className="py-10 text-center text-sm text-[color:var(--tx3)]">
            {sortedTemplates.length === 0
              ? 'No workflows yet. Build one in the designer.'
              : 'No workflows match the search.'}
          </div>
        ) : (
          <div className="divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
            {filteredTemplates.map((template) => {
              const templateInstallations =
                installationsByTemplateId.get(template.id) ?? []
              const summary = summarizeInstallations(templateInstallations)

              return (
                <button
                  className={[
                    'w-full border-l-2 px-3 py-2.5 text-left transition-colors',
                    template.id === selectedTemplate?.id
                      ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-transparent hover:bg-[var(--overlay-weak)]',
                  ].join(' ')}
                  key={template.id}
                  onClick={() => selectTemplate(template)}
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--tx)]">
                      {template.name}
                    </span>
                    <StatusPill tone={summary.tone}>{summary.label}</StatusPill>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[color:var(--tx3)]">
                    v{template.version} · {template.graph.steps.length} step
                    {template.graph.steps.length === 1 ? '' : 's'}
                    {templateInstallations.length > 0
                      ? ` · ${templateInstallations.length} installation${
                          templateInstallations.length === 1 ? '' : 's'
                        }`
                      : ''}
                    {' · '}
                    {formatRelativeTime(template.updatedAt) ??
                      formatTimestamp(template.updatedAt)}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </ColumnBrowserColumn>,
  ]

  if (selectedTemplate) {
    columns.push(
      <ColumnBrowserColumn
        key={`template-${selectedTemplate.id}`}
        onBack={() => setSelectedTemplateId(undefined)}
        showBack={isMobile}
        title={selectedTemplate.name}
      >
        <WorkflowTemplateDetail
          installations={installationsByTemplateId.get(selectedTemplate.id) ?? []}
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
        showBack={isMobile}
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
        showBack={isMobile}
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
