import { useMemo, useState } from 'react'
import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate } from 'react-router-dom'
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
import { useAuthSession } from '../providers/AuthSessionProvider'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const pillBase =
  'rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.15em]'
const primaryPill =
  `${pillBase} bg-emerald-400/20 text-emerald-200 hover:bg-emerald-400/30 disabled:opacity-50`
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

type WorkflowsPageProps = Record<string, never>

export const WorkflowsPage = (_props: WorkflowsPageProps) => {
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  const { data: templates = [] } = useWorkflowTemplates(isOwner)
  const { data: installations = [] } = useWorkflowInstallations(isOwner)

  const templatesById = useMemo(() => {
    const map = new Map<string, WorkflowTemplateRecord>()
    for (const template of templates) map.set(template.id, template)
    return map
  }, [templates])

  const latestInstallationByTemplateId = useMemo(() => {
    const map = new Map<string, WorkflowInstallationRecord>()
    for (const installation of installations) {
      if (!map.has(installation.workflowTemplateId)) {
        map.set(installation.workflowTemplateId, installation)
      }
    }
    return map
  }, [installations])

  const [selectedInstallationId, setSelectedInstallationId] = useState<
    string | undefined
  >(undefined)

  const effectiveInstallationId = selectedInstallationId ?? installations[0]?.id

  const selectedInstallation = useMemo(
    () => installations.find((inst) => inst.id === effectiveInstallationId),
    [installations, effectiveInstallationId],
  )

  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    undefined,
  )

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center justify-between gap-4 border-b border-[color:var(--sep)] px-5">
        <div className="flex items-center gap-4">
          <div className={sectionTitle}>Workflows</div>
          <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-[color:var(--tx2)]">
            {templates.length} saved
          </div>
          <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-[color:var(--tx2)]">
            {installations.length} installed
          </div>
        </div>
        <button
          className="admin-button admin-button-primary"
          onClick={() => void navigate('/agents/workflow-designer')}
          type="button"
        >
          New workflow
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 lg:grid-cols-[0.9fr_2.1fr]">
          <div className="grid gap-4">
            <div className="admin-card p-4">
              <div className={sectionTitle}>Saved workflows</div>
              <div className="mt-3 grid gap-2">
                {templates.map((template) => {
                  const linkedInstallation = latestInstallationByTemplateId.get(template.id)

                  return (
                    <button
                      key={template.id}
                      className="admin-card cursor-pointer rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2 text-left transition hover:bg-black/20"
                      onClick={() => {
                        void navigate(`/agents/workflow-designer/${template.id}`)
                      }}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-white">
                            {template.name}
                          </div>
                          <div className="mt-1 text-xs text-[color:var(--tx3)]">
                            v{template.version} · updated {formatTimestamp(template.updatedAt)}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                            {linkedInstallation ? 'installed' : 'saved'}
                          </span>
                          <FontAwesomeIcon
                            className="text-xs text-[color:var(--tx3)]"
                            icon={faChevronRight}
                          />
                        </div>
                      </div>
                    </button>
                  )
                })}
                {templates.length === 0 && (
                  <div className="py-6 text-center text-[color:var(--tx3)]">
                    No workflows saved yet
                  </div>
                )}
              </div>
            </div>

            <div className="admin-card p-4">
              <div className={sectionTitle}>Installations</div>
              <div className="mt-3 grid gap-2">
                {installations.map((installation) => {
                  const template = templatesById.get(installation.workflowTemplateId)
                  const selected = installation.id === effectiveInstallationId
                  return (
                    <button
                      key={installation.id}
                      className={`admin-card cursor-pointer rounded-xl border px-3 py-2 text-left transition ${
                        selected
                          ? 'border-emerald-400/60 bg-emerald-400/10'
                          : 'border-[color:var(--sep)] bg-black/10 hover:bg-black/20'
                      }`}
                      onClick={() => {
                        setSelectedInstallationId(installation.id)
                        setSelectedRunId(undefined)
                      }}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold text-white">
                          {template?.name ?? installation.workflowTemplateId.slice(0, 8)}
                        </div>
                        <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                          {installation.status}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-[color:var(--tx3)]">
                        v{installation.workflowTemplateVersion} · {installation.id.slice(0, 8)}
                      </div>
                    </button>
                  )
                })}
                {installations.length === 0 && (
                  <div className="py-6 text-center text-[color:var(--tx3)]">
                    No workflow installations yet
                  </div>
                )}
              </div>
            </div>
          </div>

          {selectedInstallation ? (
            <WorkflowInstallationDetail
              installation={selectedInstallation}
              template={templatesById.get(selectedInstallation.workflowTemplateId)}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
            />
          ) : (
            <div className="admin-card flex items-center justify-center p-8 text-[color:var(--tx3)]">
              Select an installation to view runs
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

type WorkflowInstallationDetailProps = {
  installation: WorkflowInstallationRecord
  template?: WorkflowTemplateRecord
  selectedRunId?: string
  onSelectRun: (runId: string | undefined) => void
}

const WorkflowInstallationDetail = ({
  installation,
  template,
  selectedRunId,
  onSelectRun,
}: WorkflowInstallationDetailProps) => {
  const { data: runs = [] } = useWorkflowInstallationRuns(installation.id)
  const { data: triggers = [] } = useWorkflowInstallationTriggers(installation.id)
  const startRun = useStartWorkflowRun()

  return (
    <div className="grid gap-4">
      <div className="admin-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className={sectionTitle}>Installation</div>
            <div className="mt-1 text-lg font-semibold text-white">
              {template?.name ?? installation.workflowTemplateId.slice(0, 8)}
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              {installation.id}
            </div>
          </div>
          <button
            className={primaryPill}
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

      <div className="admin-card p-4">
        <div className={sectionTitle}>Triggers</div>
        <div className="mt-3 grid gap-2">
          {triggers.map((trigger) => (
            <div
              key={trigger.id}
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-white">
                  {trigger.name ?? trigger.type}
                </div>
                <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                  {trigger.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">
                {trigger.type} · next {formatTimestamp(trigger.nextRunAt)}
              </div>
            </div>
          ))}
          {triggers.length === 0 && (
            <div className="py-4 text-center text-[color:var(--tx3)]">
              No triggers for this installation
            </div>
          )}
        </div>
      </div>

      <div className="admin-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className={sectionTitle}>Runs</div>
          <div className="text-xs text-[color:var(--tx3)]">{runs.length} total</div>
        </div>
        <div className="mt-3 grid gap-2">
          {runs.map((run) => {
            const selected = run.id === selectedRunId
            return (
              <button
                key={run.id}
                className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition ${
                  selected
                    ? 'border-sky-400/60 bg-sky-400/10'
                    : 'border-[color:var(--sep)] bg-black/10 hover:bg-black/20'
                }`}
                onClick={() =>
                  onSelectRun(selected ? undefined : run.id)
                }
                type="button"
              >
                <div>
                  <div className="font-semibold text-white">{run.id.slice(0, 8)}</div>
                  <div className="text-xs text-[color:var(--tx3)]">
                    started {formatTimestamp(run.startedAt ?? run.createdAt)}
                  </div>
                </div>
                <span
                  className={`text-[11px] font-semibold uppercase tracking-[0.15em] ${runStatusClass(run.status)}`}
                >
                  {run.status}
                </span>
              </button>
            )
          })}
          {runs.length === 0 && (
            <div className="py-6 text-center text-[color:var(--tx3)]">No runs yet</div>
          )}
        </div>
      </div>

      {selectedRunId && <WorkflowRunDetail workflowRunId={selectedRunId} />}
    </div>
  )
}

type WorkflowRunDetailProps = { workflowRunId: string }

const WorkflowRunDetail = ({ workflowRunId }: WorkflowRunDetailProps) => {
  const { data, isLoading } = useWorkflowRun(workflowRunId)
  const cancelRun = useCancelWorkflowRun()
  const retryRun = useRetryWorkflowRun()
  const skipStep = useSkipWorkflowStepRun()
  const blockStep = useBlockWorkflowStepRun()
  const unblockStep = useUnblockWorkflowStepRun()

  if (isLoading || !data) {
    return (
      <div className="admin-card p-4 text-[color:var(--tx3)]">
        Loading run…
      </div>
    )
  }

  const { run, steps } = data

  return (
    <div className="admin-card p-4">
      <div className="flex items-center justify-between gap-3">
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
          {run.retriedFromWorkflowRunId && (
            <div className="text-xs text-[color:var(--tx3)]">
              retried from {run.retriedFromWorkflowRunId.slice(0, 8)}
            </div>
          )}
          {run.errorMessage && (
            <div className="mt-1 text-xs text-rose-300">{run.errorMessage}</div>
          )}
        </div>
        <div className="flex gap-2">
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

      <div className="mt-4 grid gap-2">
        {steps.map((step) => {
          const canSkip =
            isActiveRun(run.status) &&
            (step.status === 'pending' || step.status === 'blocked')
          const canBlock = isActiveRun(run.status) && step.status === 'pending'
          const canUnblock = isActiveRun(run.status) && step.status === 'blocked'
          return (
            <div
              key={step.id}
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
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
              {step.errorMessage && (
                <div className="mt-1 text-xs text-rose-300">{step.errorMessage}</div>
              )}
              <div className="mt-2 flex gap-2">
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
        {steps.length === 0 && (
          <div className="py-4 text-center text-[color:var(--tx3)]">No steps</div>
        )}
      </div>
    </div>
  )
}
