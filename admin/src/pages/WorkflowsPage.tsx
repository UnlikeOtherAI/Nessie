import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { WorkflowInstallationRecord } from '../lib/api-client'
import {
  useInstallWorkflowTemplate,
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../facades/workflows/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { StatusPill } from '../components/primitives/StatusPill'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserItem } from '../components/shared/column-browser/ColumnBrowserItem'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { WorkflowInstallationDetail } from '../components/features/workflows/WorkflowInstallationDetail'
import { WorkflowRunDetail } from '../components/features/workflows/WorkflowRunDetail'
import { WorkflowTemplateDetail } from '../components/features/workflows/WorkflowTemplateDetail'
import {
  formatTimestamp,
  getInstallationTone,
  getWorkflowTemplateLabel,
  sectionTitle,
} from '../components/features/workflows/presentation'

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
  const [selectedTemplateId, setSelectedTemplateId] = useState<
    string | undefined
  >(() => restoredSelection.selectedTemplateId)
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

  const sortedInstallations = useMemo(
    () =>
      [...installations].sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [installations],
  )

  const templatesById = useMemo(
    () => new Map(sortedTemplates.map((template) => [template.id, template])),
    [sortedTemplates],
  )

  const latestInstallationByTemplateId = useMemo(() => {
    const map = new Map<string, WorkflowInstallationRecord>()
    for (const installation of [...sortedInstallations].sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )) {
      if (!map.has(installation.workflowTemplateId)) {
        map.set(installation.workflowTemplateId, installation)
      }
    }
    return map
  }, [sortedInstallations])

  const installationCountByTemplateId = useMemo(() => {
    const map = new Map<string, number>()
    for (const installation of sortedInstallations) {
      map.set(
        installation.workflowTemplateId,
        (map.get(installation.workflowTemplateId) ?? 0) + 1,
      )
    }
    return map
  }, [sortedInstallations])

  const selectedTemplate = useMemo(
    () =>
      selectedTemplateId
        ? sortedTemplates.find((template) => template.id === selectedTemplateId)
        : undefined,
    [selectedTemplateId, sortedTemplates],
  )

  const effectiveInstallationId =
    selectedInstallationId &&
    sortedInstallations.some((installation) => installation.id === selectedInstallationId)
      ? selectedInstallationId
      : sortedInstallations[0]?.id

  const selectedInstallation = useMemo(
    () =>
      sortedInstallations.find(
        (installation) => installation.id === effectiveInstallationId,
      ),
    [effectiveInstallationId, sortedInstallations],
  )

  useEffect(() => {
    setSelectedTemplateId(restoredSelection.selectedTemplateId)
    setSelectedInstallationId(restoredSelection.selectedInstallationId)
    setSelectedRunId(restoredSelection.selectedRunId)
  }, [
    restoredSelection.selectedInstallationId,
    restoredSelection.selectedRunId,
    restoredSelection.selectedTemplateId,
  ])

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  const currentWorkflowLocationState: WorkflowsPageLocationState = selectedTemplate
    ? {
        selectedTemplateId: selectedTemplate.id,
      }
    : {
        selectedInstallationId,
        selectedRunId,
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
      title="Workflows"
    >
      <div className="grid gap-6">
        <div>
          <div className={sectionTitle}>Saved workflows</div>
          <div className="mt-3 grid gap-3">
            {sortedTemplates.map((template) => {
              const linkedInstallation = latestInstallationByTemplateId.get(template.id)

              return (
                <ColumnBrowserItem
                  caption={`v${template.version} · updated ${formatTimestamp(template.updatedAt)}`}
                  isSelected={template.id === selectedTemplate?.id}
                  key={template.id}
                  meta={
                    <StatusPill tone={linkedInstallation ? 'accent' : 'muted'}>
                      {linkedInstallation ? 'installed' : 'saved'}
                    </StatusPill>
                  }
                  onClick={() => {
                    setSelectedTemplateId(template.id)
                    setSelectedInstallationId(undefined)
                    setSelectedRunId(undefined)
                  }}
                  subtitle={linkedInstallation ? linkedInstallation.id.slice(0, 8) : 'Ready to edit'}
                  title={template.name}
                >
                  {linkedInstallation
                    ? `Latest installation is ${linkedInstallation.status}.`
                    : 'Saved workflow with no active installation yet.'}
                </ColumnBrowserItem>
              )
            })}
            {sortedTemplates.length === 0 ? (
              <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
                No workflows saved yet.
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <div className={sectionTitle}>Installations</div>
          <div className="mt-3 grid gap-3">
            {sortedInstallations.map((installation) => {
              const template = templatesById.get(installation.workflowTemplateId)
              return (
                <ColumnBrowserItem
                  caption={`Updated ${formatTimestamp(installation.updatedAt)}`}
                  isSelected={
                    !selectedTemplate && installation.id === effectiveInstallationId
                  }
                  key={installation.id}
                  meta={
                    <StatusPill tone={getInstallationTone(installation.status)}>
                      {installation.status}
                    </StatusPill>
                  }
                  onClick={() => {
                    setSelectedTemplateId(undefined)
                    setSelectedInstallationId(installation.id)
                    setSelectedRunId(undefined)
                  }}
                  subtitle={`v${installation.workflowTemplateVersion} · ${installation.id.slice(0, 8)}`}
                  title={getWorkflowTemplateLabel(template, installation)}
                >
                  {installation.channelId
                    ? `Bound to channel ${installation.channelId.slice(0, 8)}.`
                    : 'Not bound to a channel yet.'}
                </ColumnBrowserItem>
              )
            })}
            {sortedInstallations.length === 0 ? (
              <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
                No workflow installations yet.
              </div>
            ) : null}
          </div>
        </div>
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
          installationCount={
            installationCountByTemplateId.get(selectedTemplate.id) ?? 0
          }
          isInstalling={installWorkflowTemplate.isPending}
          latestInstallation={latestInstallationByTemplateId.get(selectedTemplate.id)}
          onInstall={() =>
            installWorkflowTemplate.mutate(
              { workflowTemplateId: selectedTemplate.id },
              {
                onSuccess: (installation) => {
                  setSelectedTemplateId(undefined)
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
          template={selectedTemplate}
        />
      </ColumnBrowserColumn>,
    )
  } else if (selectedInstallation) {
    columns.push(
      <ColumnBrowserColumn
        key={`installation-${selectedInstallation.id}`}
        onBack={() => {
          setSelectedInstallationId(undefined)
          setSelectedRunId(undefined)
        }}
        showBack={isMobile}
        title={getWorkflowTemplateLabel(
          templatesById.get(selectedInstallation.workflowTemplateId),
          selectedInstallation,
        )}
      >
        <WorkflowInstallationDetail
          installation={selectedInstallation}
          onSelectRun={setSelectedRunId}
          selectedRunId={selectedRunId}
          template={templatesById.get(selectedInstallation.workflowTemplateId)}
        />
      </ColumnBrowserColumn>,
    )
  }

  if (selectedRunId) {
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

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={
          selectedRunId
            ? 2
            : selectedTemplate
              ? 1
              : selectedInstallationId && selectedInstallation
              ? 1
              : 0
        }
        columns={columns}
      />
    </div>
  )
}
