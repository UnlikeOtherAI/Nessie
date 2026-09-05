import { useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type {
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import { useAgents } from '../../../facades/agents/hooks'
import { useChannels } from '../../../facades/channels/hooks'
import {
  useStartWorkflowRun,
  useWorkflowInstallationTriggers,
} from '../../../facades/workflows/hooks'
import { usePagedList } from '../../../facades/pagination/usePagedList'
import { workflowKeys } from '../../../lib/query-keys'
import { EmptyState } from '../../shared/EmptyState'
import { KeyValueList } from '../../shared/KeyValueList'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { Pill } from '../../primitives/Pill'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
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

export const WorkflowInstallationDetail = ({
  installation,
  onSelectRun,
  selectedRunId,
  template,
  templates,
}: WorkflowInstallationDetailProps) => {
  const runsList = usePagedList<WorkflowRunRecord>({
    path: `/api/workflow-installations/${installation.id}/runs`,
    paramPrefix: 'runs-',
    queryKey: workflowKeys.installationRuns(installation.id),
  })
  const runs = runsList.items
  const { data: triggers = [] } = useWorkflowInstallationTriggers(installation.id)
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const startRun = useStartWorkflowRun()
  const [isTriggerDialogOpen, setTriggerDialogOpen] = useState(false)

  const channelLabel = installation.channelId
    ? channels.find((channel) => channel.id === installation.channelId)?.label ??
      installation.channelId.slice(0, 8)
    : 'Not bound'

  // The server already orders runs newest-first (`orderBy: [createdAt desc]`);
  // no client re-sort needed on top of a paged fetch.
  const sortedRuns = runs

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

      <KeyValueList
        items={[
          { label: 'Channel', value: channelLabel },
          { label: 'Template version', value: `v${installation.workflowTemplateVersion}` },
          { label: 'Created', value: formatTimestamp(installation.createdAt) },
          { label: 'Updated', value: formatTimestamp(installation.updatedAt) },
        ]}
      />

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
          <EmptyState className="mt-3">
            No triggers yet — add one so this workflow fires on a schedule,
            webhook or event.
          </EmptyState>
        ) : (
          <RowList className="mt-3" label="Triggers">
            {sortedTriggers.map((trigger) => (
              <Row
                href={`/agents/triggers#trigger-${encodeURIComponent(trigger.id)}`}
                key={trigger.id}
                leading={
                  <FontAwesomeIcon
                    className="h-3 w-3 text-[color:var(--tx3)]"
                    icon={TRIGGER_TYPE_ICONS[trigger.type]}
                  />
                }
                subtitle={getScheduleSummary(trigger)}
                title={trigger.name ?? trigger.type}
                trailing={
                  <>
                    {trigger.nextRunAt ? (
                      <span className="text-[11px] tabular-nums text-[color:var(--tx3)]">
                        {formatRelativeTime(trigger.nextRunAt)}
                      </span>
                    ) : null}
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: getTriggerStatusColor(trigger.status) }}
                      title={trigger.status}
                    />
                  </>
                }
              />
            ))}
          </RowList>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <SectionLabel>Runs</SectionLabel>
          <div className="text-xs text-[color:var(--tx3)]">
            {runsList.total ?? sortedRuns.length} total
          </div>
        </div>
        <QueryState
          className="mt-3 py-6"
          emptyLabel="No runs yet. Use “Start run” to execute this workflow now."
          errorLabel="Runs could not be loaded."
          isEmpty={sortedRuns.length === 0}
          loadingLabel="Loading runs…"
          query={runsList.query}
        >
          {() => (
            <>
              <RowList label="Runs">
                {sortedRuns.map((run) => {
                  const duration = formatDuration(run.startedAt ?? run.createdAt, run.finishedAt)
                  return (
                    <Row
                      key={run.id}
                      leading={
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: getRunStatusColor(run.status) }}
                          title={run.status}
                        />
                      }
                      onClick={() => onSelectRun(run.id === selectedRunId ? undefined : run.id)}
                      selected={run.id === selectedRunId}
                      subtitle={run.errorMessage ? undefined : run.summary ?? undefined}
                      title={
                        <span className="flex items-baseline gap-2">
                          <span>{run.status}</span>
                          <span className="text-xs text-[color:var(--tx3)]">
                            {formatRelativeTime(run.startedAt ?? run.createdAt)}
                            {duration ? ` · ${duration}` : ''}
                          </span>
                        </span>
                      }
                      trailing={
                        <span className="text-xs text-[color:var(--tx3)]">
                          {run.id.slice(0, 8)}
                        </span>
                      }
                    >
                      {run.errorMessage ? (
                        <span className="mt-0.5 block truncate text-xs text-[var(--danger-text)]">
                          {run.errorMessage}
                        </span>
                      ) : null}
                    </Row>
                  )
                })}
              </RowList>
              <PaginationFooter
                canNext={runsList.canNext}
                canPrevious={runsList.canPrevious}
                className="mt-3"
                hideWhenSinglePage
              label={runsList.label}
              onPageChange={runsList.onPageChange}
              onPageSizeChange={runsList.onPageSizeChange}
              page={runsList.page}
              pageCount={runsList.pageCount}
              pageSize={runsList.pageSize}
              />
            </>
          )}
        </QueryState>
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
