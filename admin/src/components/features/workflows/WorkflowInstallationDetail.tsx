import { useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Link } from 'react-router-dom'
import type {
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import { useAgents } from '../../../facades/agents/hooks'
import { useChannels } from '../../../facades/channels/hooks'
import {
  useStartWorkflowRun,
  useWorkflowInstallationRuns,
  useWorkflowInstallationTriggers,
} from '../../../facades/workflows/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { TriggerEditorDialog } from '../triggers/TriggerEditorDialog'
import {
  TRIGGER_TYPE_ICONS,
  getScheduleSummary,
  getTriggerStatusColor,
} from '../triggers/trigger-presentation'
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  getInstallationTone,
  getRunStatusColor,
  getWorkflowTemplateLabel,
} from './presentation'

/**
 * Installation detail — the operational hub for one installed workflow:
 * start runs, attach triggers in place (same editor as the Triggers page),
 * and inspect run history. Facts render once in a definition list.
 */

type WorkflowInstallationDetailProps = {
  installation: WorkflowInstallationRecord
  onSelectRun: (runId: string | undefined) => void
  selectedRunId?: string
  template?: WorkflowTemplateRecord
  templates: WorkflowTemplateRecord[]
}

const FactRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 px-3 py-2.5">
    <dt className="flex-shrink-0 text-xs text-[color:var(--tx3)]">{label}</dt>
    <dd className="min-w-0 text-right text-sm text-[var(--tx)]">{value}</dd>
  </div>
)

export const WorkflowInstallationDetail = ({
  installation,
  onSelectRun,
  selectedRunId,
  template,
  templates,
}: WorkflowInstallationDetailProps) => {
  const { data: runs = [] } = useWorkflowInstallationRuns(installation.id)
  const { data: triggers = [] } = useWorkflowInstallationTriggers(installation.id)
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const startRun = useStartWorkflowRun()
  const [isTriggerDialogOpen, setTriggerDialogOpen] = useState(false)

  const channelLabel = installation.channelId
    ? channels.find((channel) => channel.id === installation.channelId)?.label ??
      installation.channelId.slice(0, 8)
    : 'Not bound'

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

  const canStartRun = installation.active && installation.status !== 'disabled'

  return (
    <div className="grid max-w-3xl gap-5">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-[var(--tx)]">
                {getWorkflowTemplateLabel(template, installation)}
              </h2>
              <Pill tone={getInstallationTone(installation.status)}>
                {installation.status}
              </Pill>
            </div>
            <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
              Installation {installation.id.slice(0, 8)} · template v
              {installation.workflowTemplateVersion}
            </div>
          </div>
          <button
            className="admin-button admin-button-primary flex-shrink-0"
            disabled={!canStartRun || startRun.isPending}
            onClick={() =>
              startRun.mutate({ installationId: installation.id, input: {} })
            }
            type="button"
          >
            {startRun.isPending ? 'Starting…' : 'Start run'}
          </button>
        </div>
        {!canStartRun ? (
          <p className="mt-2 text-xs text-[color:var(--tx3)]">
            This installation is {installation.status}; runs and triggers will not
            fire until it is active.
          </p>
        ) : null}
      </div>

      <dl className="divide-y divide-[color:var(--sep)] rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
        <FactRow label="Channel" value={channelLabel} />
        <FactRow label="Template version" value={`v${installation.workflowTemplateVersion}`} />
        <FactRow label="Created" value={formatTimestamp(installation.createdAt)} />
        <FactRow label="Updated" value={formatTimestamp(installation.updatedAt)} />
      </dl>

      <section>
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Triggers</SectionLabel>
          <button
            className="admin-button admin-button-secondary"
            onClick={() => setTriggerDialogOpen(true)}
            type="button"
          >
            Add trigger
          </button>
        </div>
        {sortedTriggers.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[color:var(--sep)] px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
            No triggers yet — add one so this workflow fires on a schedule,
            webhook or event.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
            {sortedTriggers.map((trigger) => (
              <Link
                className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--overlay-weak)]"
                key={trigger.id}
                to={`/agents/triggers#trigger-${encodeURIComponent(trigger.id)}`}
              >
                <FontAwesomeIcon
                  className="h-3 w-3 flex-shrink-0 text-[color:var(--tx3)]"
                  icon={TRIGGER_TYPE_ICONS[trigger.type]}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--tx)]">
                    {trigger.name ?? trigger.type}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[color:var(--tx3)]">
                    {getScheduleSummary(trigger)}
                  </div>
                </div>
                {trigger.nextRunAt ? (
                  <span className="flex-shrink-0 text-[11px] tabular-nums text-[color:var(--tx3)]">
                    {formatRelativeTime(trigger.nextRunAt)}
                  </span>
                ) : null}
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ background: getTriggerStatusColor(trigger.status) }}
                  title={trigger.status}
                />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <SectionLabel>Runs</SectionLabel>
          <div className="text-xs text-[color:var(--tx3)]">{sortedRuns.length} total</div>
        </div>
        {sortedRuns.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[color:var(--sep)] px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
            No runs yet. Use “Start run” to execute this workflow now.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
            {sortedRuns.map((run) => {
              const duration = formatDuration(run.startedAt ?? run.createdAt, run.finishedAt)
              return (
                <button
                  className={[
                    'flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left transition-colors',
                    run.id === selectedRunId
                      ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-transparent hover:bg-[var(--overlay-weak)]',
                  ].join(' ')}
                  key={run.id}
                  onClick={() => onSelectRun(run.id === selectedRunId ? undefined : run.id)}
                  type="button"
                >
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: getRunStatusColor(run.status) }}
                    title={run.status}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-[var(--tx)]">
                        {run.status}
                      </span>
                      <span className="text-xs text-[color:var(--tx3)]">
                        {formatRelativeTime(run.startedAt ?? run.createdAt)}
                        {duration ? ` · ${duration}` : ''}
                      </span>
                    </div>
                    {run.summary || run.errorMessage ? (
                      <div
                        className={[
                          'mt-0.5 truncate text-xs',
                          run.errorMessage
                            ? 'text-[var(--danger-text)]'
                            : 'text-[color:var(--tx3)]',
                        ].join(' ')}
                      >
                        {run.errorMessage ?? run.summary}
                      </div>
                    ) : null}
                  </div>
                  <span className="flex-shrink-0 text-xs text-[color:var(--tx3)]">
                    {run.id.slice(0, 8)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <TriggerEditorDialog
        agents={agents}
        channels={channels}
        defaultTarget={{
          targetKind: 'workflow',
          workflowInstallationId: installation.id,
        }}
        onClose={() => setTriggerDialogOpen(false)}
        onSaved={() => setTriggerDialogOpen(false)}
        open={isTriggerDialogOpen}
        workflowInstallations={[installation]}
        workflowTemplates={templates}
      />
    </div>
  )
}
