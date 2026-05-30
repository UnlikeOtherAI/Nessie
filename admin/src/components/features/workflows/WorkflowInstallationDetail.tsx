import { useMemo } from 'react'
import type {
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import {
  useStartWorkflowRun,
  useWorkflowInstallationRuns,
  useWorkflowInstallationTriggers,
} from '../../../facades/workflows/hooks'
import { StatusPill } from '../../primitives/StatusPill'
import { ColumnBrowserItem } from '../../shared/column-browser/ColumnBrowserItem'
import {
  formatTimestamp,
  getInstallationTone,
  getRunTone,
  getWorkflowTemplateLabel,
  sectionTitle,
} from './presentation'

type WorkflowInstallationDetailProps = {
  installation: WorkflowInstallationRecord
  onSelectRun: (runId: string | undefined) => void
  selectedRunId?: string
  template?: WorkflowTemplateRecord
}

export const WorkflowInstallationDetail = ({
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
