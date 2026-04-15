import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type {
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowStepRunRecord,
  WorkflowTemplateRecord,
} from '../lib/api-client'
import {
  useBlockWorkflowStepRun,
  useCancelWorkflowRun,
  useRetryWorkflowRun,
  useSkipWorkflowStepRun,
  useStartWorkflowRun,
  useUnblockWorkflowStepRun,
  useWorkflowInstallationRuns,
  useWorkflowInstallationTriggers,
  useWorkflowInstallations,
  useWorkflowRun,
  useWorkflowTemplates,
} from '../facades/workflows/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { StatusPill } from '../components/primitives/StatusPill'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserItem } from '../components/shared/column-browser/ColumnBrowserItem'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const pillBase =
  'rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.15em]'
const dangerPill =
  `${pillBase} bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 disabled:opacity-40`
const infoPill =
  `${pillBase} bg-sky-500/20 text-sky-200 hover:bg-sky-500/30 disabled:opacity-40`
const stepActionPillBase =
  'rounded-full bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase'
const stepActionPill =
  `${stepActionPillBase} tracking-[0.12em] text-[color:var(--tx2)] hover:bg-white/10 disabled:opacity-30`

const formatTimestamp = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—'

const getWorkflowTemplateLabel = (
  template: WorkflowTemplateRecord | undefined,
  installation: WorkflowInstallationRecord,
) => template?.name ?? installation.workflowTemplateId.slice(0, 8)

const getInstallationTone = (status: WorkflowInstallationRecord['status']) => {
  switch (status) {
    case 'active':
      return 'success' as const
    case 'paused':
      return 'warning' as const
    case 'disabled':
      return 'danger' as const
    case 'draft':
      return 'muted' as const
    default:
      return 'muted' as const
  }
}

const getRunTone = (status: WorkflowRunRecord['status']) => {
  switch (status) {
    case 'running':
      return 'success' as const
    case 'pending':
      return 'warning' as const
    case 'completed':
      return 'accent' as const
    case 'failed':
      return 'danger' as const
    case 'cancelled':
      return 'muted' as const
    default:
      return 'muted' as const
  }
}

const runStatusClass = (status: WorkflowRunRecord['status']): string => {
  switch (status) {
    case 'running':
      return 'text-emerald-300'
    case 'pending':
      return 'text-amber-300'
    case 'completed':
      return 'text-sky-300'
    case 'failed':
      return 'text-rose-300'
    case 'cancelled':
      return 'text-[color:var(--tx3)]'
    default:
      return 'text-white'
  }
}

const stepStatusClass = (status: WorkflowStepRunRecord['status']): string => {
  switch (status) {
    case 'running':
      return 'text-emerald-300'
    case 'pending':
      return 'text-amber-300'
    case 'completed':
      return 'text-sky-300'
    case 'failed':
      return 'text-rose-300'
    case 'skipped':
      return 'text-[color:var(--tx3)]'
    case 'blocked':
      return 'text-orange-300'
    default:
      return 'text-white'
  }
}

const isActiveRun = (status: WorkflowRunRecord['status']): boolean =>
  status === 'pending' || status === 'running'

const isTerminalRun = (status: WorkflowRunRecord['status']): boolean =>
  status === 'cancelled' || status === 'completed' || status === 'failed'

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

type WorkflowTemplateDetailProps = {
  installationCount: number
  latestInstallation?: WorkflowInstallationRecord
  onEdit: () => void
  template: WorkflowTemplateRecord
}

const WorkflowTemplateDetail = ({
  installationCount,
  latestInstallation,
  onEdit,
  template,
}: WorkflowTemplateDetailProps) => {
  const stepCount = template.graph.steps.length
  const environmentCount = template.requiredEnvironmentTemplateIds.length

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-white">
                {template.name}
              </h2>
              <StatusPill tone={latestInstallation ? 'accent' : 'muted'}>
                {latestInstallation ? 'installed' : 'saved'}
              </StatusPill>
            </div>
            <div className="mt-3 text-sm text-[color:var(--tx2)]">
              Workflow template {template.id.slice(0, 8)} with {stepCount} step
              {stepCount === 1 ? '' : 's'}.
            </div>
          </div>

          <button
            className="admin-button admin-button-primary"
            onClick={onEdit}
            type="button"
          >
            Edit
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {[
          ['Version', `${template.version}`],
          ['Updated', formatTimestamp(template.updatedAt)],
          ['Installations', `${installationCount}`],
          ['Environment templates', `${environmentCount}`],
        ].map(([label, value]) => (
          <div
            className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-3"
            key={label}
          >
            <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {label}
            </div>
            <div className="mt-2 text-sm text-white">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className={sectionTitle}>Latest installation</div>
        {latestInstallation ? (
          <div className="mt-3 rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-white">
                {latestInstallation.id.slice(0, 8)}
              </div>
              <StatusPill tone={getInstallationTone(latestInstallation.status)}>
                {latestInstallation.status}
              </StatusPill>
            </div>
            <div className="mt-2 text-sm text-[color:var(--tx2)]">
              Version {latestInstallation.workflowTemplateVersion}
              {latestInstallation.channelId
                ? ` · channel ${latestInstallation.channelId.slice(0, 8)}`
                : ' · not bound to a channel'}
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx3)]">
              Updated {formatTimestamp(latestInstallation.updatedAt)}
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-[color:var(--sep)] bg-black/10 p-4 text-sm text-[color:var(--tx3)]">
            This workflow has not been installed yet.
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className={sectionTitle}>Workflow structure</div>
        <div className="mt-3 grid gap-2">
          {template.graph.steps.map((step, index) => (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
              key={step.id}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-white">
                  {index + 1}. {step.title ?? step.type}
                </div>
                <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {step.type}
                </span>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">{step.id}</div>
            </div>
          ))}
          {template.graph.steps.length === 0 ? (
            <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4 text-center text-sm text-[color:var(--tx3)]">
              No steps defined yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

type WorkflowInstallationDetailProps = {
  installation: WorkflowInstallationRecord
  onSelectRun: (runId: string | undefined) => void
  selectedRunId?: string
  template?: WorkflowTemplateRecord
}

const WorkflowInstallationDetail = ({
  installation,
  onSelectRun,
  selectedRunId,
  template,
}: WorkflowInstallationDetailProps) => {
  const { data: runs = [] } = useWorkflowInstallationRuns(installation.id)
  const { data: triggers = [] } = useWorkflowInstallationTriggers(installation.id)
  const startRun = useStartWorkflowRun()

  const sortedRuns = useMemo(
    () =>
      [...runs].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      ),
    [runs],
  )

  const sortedTriggers = useMemo(
    () =>
      [...triggers].sort((left, right) =>
        (left.name ?? left.type).localeCompare(right.name ?? right.type),
      ),
    [triggers],
  )

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-white">
                {getWorkflowTemplateLabel(template, installation)}
              </h2>
              <StatusPill tone={getInstallationTone(installation.status)}>
                {installation.status}
              </StatusPill>
            </div>
            <div className="mt-3 text-sm text-[color:var(--tx2)]">
              Installation {installation.id.slice(0, 8)} running template version{' '}
              {installation.workflowTemplateVersion}.
            </div>
          </div>

          <button
            className="admin-button admin-button-primary"
            disabled={!installation.active || startRun.isPending}
            onClick={() =>
              startRun.mutate({ installationId: installation.id, input: {} })
            }
            type="button"
          >
            {startRun.isPending ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {[
          ['Template ID', installation.workflowTemplateId],
          ['Channel', installation.channelId ?? 'Not bound'],
          ['Created', formatTimestamp(installation.createdAt)],
          ['Updated', formatTimestamp(installation.updatedAt)],
        ].map(([label, value]) => (
          <div
            className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-3"
            key={label}
          >
            <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {label}
            </div>
            <div className="mt-2 break-all text-sm text-white">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className={sectionTitle}>Triggers</div>
        <div className="mt-3 grid gap-2">
          {sortedTriggers.map((trigger) => (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
              key={trigger.id}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-white">
                  {trigger.name ?? trigger.type}
                </div>
                <StatusPill tone={trigger.status === 'active' ? 'success' : 'warning'}>
                  {trigger.status}
                </StatusPill>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">
                {trigger.type} · next {formatTimestamp(trigger.nextRunAt)}
              </div>
            </div>
          ))}
          {sortedTriggers.length === 0 ? (
            <div className="py-4 text-center text-sm text-[color:var(--tx3)]">
              No triggers attached to this installation.
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className={sectionTitle}>Runs</div>
          <div className="text-xs text-[color:var(--tx3)]">{sortedRuns.length} total</div>
        </div>
        <div className="mt-3 grid gap-2">
          {sortedRuns.map((run) => (
            <ColumnBrowserItem
              caption={`Finished ${formatTimestamp(run.finishedAt)}`}
              isSelected={run.id === selectedRunId}
              key={run.id}
              meta={<StatusPill tone={getRunTone(run.status)}>{run.status}</StatusPill>}
              onClick={() =>
                onSelectRun(run.id === selectedRunId ? undefined : run.id)
              }
              subtitle={`Started ${formatTimestamp(run.startedAt ?? run.createdAt)}`}
              title={run.id.slice(0, 8)}
            >
              {run.summary ?? run.errorMessage ?? 'Workflow run ready for inspection.'}
            </ColumnBrowserItem>
          ))}
          {sortedRuns.length === 0 ? (
            <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
              No runs yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

type WorkflowRunDetailProps = {
  workflowRunId: string
}

const WorkflowRunDetail = ({ workflowRunId }: WorkflowRunDetailProps) => {
  const { data, isLoading } = useWorkflowRun(workflowRunId)
  const cancelRun = useCancelWorkflowRun()
  const retryRun = useRetryWorkflowRun()
  const skipStep = useSkipWorkflowStepRun()
  const blockStep = useBlockWorkflowStepRun()
  const unblockStep = useUnblockWorkflowStepRun()

  if (isLoading || !data) {
    return (
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4 text-[color:var(--tx3)]">
        Loading run…
      </div>
    )
  }

  const { run, steps } = data

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={sectionTitle}>Run detail</div>
            <div className="mt-1 text-sm font-semibold text-white">
              {run.id.slice(0, 8)} ·{' '}
              <span className={runStatusClass(run.status)}>{run.status}</span>
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              started {formatTimestamp(run.startedAt ?? run.createdAt)} · finished{' '}
              {formatTimestamp(run.finishedAt)}
            </div>
            {run.retriedFromWorkflowRunId ? (
              <div className="text-xs text-[color:var(--tx3)]">
                retried from {run.retriedFromWorkflowRunId.slice(0, 8)}
              </div>
            ) : null}
            {run.errorMessage ? (
              <div className="mt-1 text-xs text-rose-300">{run.errorMessage}</div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className={dangerPill}
              disabled={!isActiveRun(run.status) || cancelRun.isPending}
              onClick={() => cancelRun.mutate({ workflowRunId: run.id })}
              type="button"
            >
              Cancel
            </button>
            <button
              className={infoPill}
              disabled={!isTerminalRun(run.status) || retryRun.isPending}
              onClick={() => retryRun.mutate({ workflowRunId: run.id })}
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        {steps.map((step) => {
          const canSkip =
            isActiveRun(run.status) &&
            (step.status === 'pending' || step.status === 'blocked')
          const canBlock = isActiveRun(run.status) && step.status === 'pending'
          const canUnblock = isActiveRun(run.status) && step.status === 'blocked'

          return (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
              key={step.id}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-white">
                    {step.sequence + 1}. {step.title}
                  </div>
                  <div className="text-xs text-[color:var(--tx3)]">
                    {step.stepKey} · {step.stepType}
                  </div>
                </div>
                <span
                  className={`text-[11px] font-semibold uppercase tracking-[0.15em] ${stepStatusClass(step.status)}`}
                >
                  {step.status}
                </span>
              </div>
              {step.errorMessage ? (
                <div className="mt-1 text-xs text-rose-300">{step.errorMessage}</div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className={stepActionPill}
                  disabled={!canSkip || skipStep.isPending}
                  onClick={() =>
                    skipStep.mutate({
                      workflowStepRunId: step.id,
                      workflowRunId: run.id,
                    })
                  }
                  type="button"
                >
                  Skip
                </button>
                <button
                  className={stepActionPill}
                  disabled={!canBlock || blockStep.isPending}
                  onClick={() =>
                    blockStep.mutate({
                      workflowStepRunId: step.id,
                      workflowRunId: run.id,
                    })
                  }
                  type="button"
                >
                  Block
                </button>
                <button
                  className={stepActionPill}
                  disabled={!canUnblock || unblockStep.isPending}
                  onClick={() =>
                    unblockStep.mutate({
                      workflowStepRunId: step.id,
                      workflowRunId: run.id,
                    })
                  }
                  type="button"
                >
                  Unblock
                </button>
              </div>
            </div>
          )
        })}
        {steps.length === 0 ? (
          <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4 text-center text-sm text-[color:var(--tx3)]">
            No step runs recorded yet.
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const WorkflowsPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: templates = [] } = useWorkflowTemplates(isOwner)
  const { data: installations = [] } = useWorkflowInstallations(isOwner)
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
          latestInstallation={latestInstallationByTemplateId.get(selectedTemplate.id)}
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
