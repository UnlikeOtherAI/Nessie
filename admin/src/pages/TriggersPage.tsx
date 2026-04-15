import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { TriggerEditorDialog } from '../components/features/triggers/TriggerEditorDialog'
import {
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
  useTriggers,
  useUpcomingTriggers,
} from '../facades/triggers/hooks'
import { useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import {
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../facades/workflows/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../lib/api-client'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { StatusPill } from '../components/primitives/StatusPill'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserItem } from '../components/shared/column-browser/ColumnBrowserItem'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const parseTriggerHash = (hash: string): string | undefined => {
  const match = hash.match(/^#trigger-(.+)$/)
  const encodedTriggerId = match?.[1]
  return encodedTriggerId ? decodeURIComponent(encodedTriggerId) : undefined
}

const formatTimestamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : '—'

const getTriggerTone = (status: AgentTriggerRecord['status']) => {
  switch (status) {
    case 'active':
      return 'success' as const
    case 'paused':
      return 'warning' as const
    case 'error':
      return 'danger' as const
    default:
      return 'muted' as const
  }
}

const getTriggerTypeLabel = (trigger: AgentTriggerRecord): string => {
  if (trigger.type === 'manual') return 'Manual start'
  if (trigger.type === 'interval') return 'Repeating interval'
  if (trigger.type === 'webhook') return 'Webhook'
  if (trigger.type === 'event') return 'System event'

  const cronExpression =
    typeof trigger.config?.cron === 'string' && trigger.config.cron.trim().length > 0
      ? trigger.config.cron
      : undefined

  return cronExpression ? 'Cron schedule' : 'One-off schedule'
}

const getWorkflowInstallationLabel = (
  installation: WorkflowInstallationRecord,
  templatesById: Map<string, WorkflowTemplateRecord>,
): string => {
  const template = templatesById.get(installation.workflowTemplateId)
  if (template) {
    return `${template.name} · ${installation.id.slice(0, 8)}`
  }

  return `Workflow ${installation.id.slice(0, 8)}`
}

const formatTriggerTarget = (
  trigger: Pick<
    AgentTriggerRecord,
    'agentId' | 'targetChannelId' | 'workflowInstallationId'
  >,
  input: {
    agentsById: Map<string, AgentRecord>
    channelsById: Map<string, ChannelRecord>
    workflowInstallationsById: Map<string, WorkflowInstallationRecord>
    workflowTemplatesById: Map<string, WorkflowTemplateRecord>
  },
): string => {
  if (trigger.agentId) {
    const agent = input.agentsById.get(trigger.agentId)
    const channel = trigger.targetChannelId
      ? input.channelsById.get(trigger.targetChannelId)
      : undefined
    if (agent && channel) {
      return `${agent.name} in #${channel.label}`
    }
    if (agent) {
      return agent.name
    }
    return `agent ${trigger.agentId.slice(0, 8)}`
  }

  if (trigger.workflowInstallationId) {
    const installation = input.workflowInstallationsById.get(trigger.workflowInstallationId)
    if (installation) {
      return getWorkflowInstallationLabel(installation, input.workflowTemplatesById)
    }
    return `workflow ${trigger.workflowInstallationId.slice(0, 8)}`
  }

  return 'unassigned'
}

const getTriggerConfigRows = (trigger: AgentTriggerRecord): Array<[string, string]> => {
  if (trigger.type === 'scheduled') {
    const cronExpression =
      typeof trigger.config?.cron === 'string' && trigger.config.cron.trim().length > 0
        ? trigger.config.cron
        : undefined
    const timezone =
      typeof trigger.config?.timezone === 'string' && trigger.config.timezone.trim().length > 0
        ? trigger.config.timezone
        : undefined

    if (cronExpression) {
      return [
        ['Schedule', cronExpression],
        ['Timezone', timezone ?? 'Default'],
      ]
    }

    return [['Run at', formatTimestamp(trigger.nextRunAt)]]
  }

  if (trigger.type === 'interval') {
    const intervalMinutes =
      typeof trigger.config?.interval_minutes === 'number'
        ? `${trigger.config.interval_minutes} minutes`
        : 'Not set'
    return [
      ['Every', intervalMinutes],
      ['First run', formatTimestamp(trigger.nextRunAt)],
    ]
  }

  if (trigger.type === 'webhook') {
    return [
      ['Endpoint', '/api/triggers/webhook'],
      ['API key', trigger.webhookApiKey ?? 'Not generated yet'],
    ]
  }

  if (trigger.type === 'event') {
    const events = Array.isArray(trigger.config?.events)
      ? trigger.config.events.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : []

    return [['Events', events.length > 0 ? events.join(', ') : 'Not configured']]
  }

  return [['Mode', 'Run when manually started']]
}

type TriggerDetailProps = {
  agentsById: Map<string, AgentRecord>
  channelsById: Map<string, ChannelRecord>
  onEdit: () => void
  trigger: AgentTriggerRecord
  workflowInstallationsById: Map<string, WorkflowInstallationRecord>
  workflowTemplatesById: Map<string, WorkflowTemplateRecord>
}

const TriggerDetail = ({
  agentsById,
  channelsById,
  onEdit,
  trigger,
  workflowInstallationsById,
  workflowTemplatesById,
}: TriggerDetailProps) => {
  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const fireTrigger = useFireTrigger()
  const { data: history = [] } = useTriggerHistory(trigger.id, 8)
  const triggerConfigRows = getTriggerConfigRows(trigger)

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-white">
                {trigger.name ?? trigger.type}
              </h2>
              <StatusPill tone={getTriggerTone(trigger.status)}>
                {trigger.status}
              </StatusPill>
            </div>
            <div className="mt-3 text-sm text-[color:var(--tx2)]">
              {trigger.description ??
                `Target ${formatTriggerTarget(trigger, {
                  agentsById,
                  channelsById,
                  workflowInstallationsById,
                  workflowTemplatesById,
                })} via ${getTriggerTypeLabel(trigger).toLowerCase()}.`}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className="admin-button admin-button-primary"
              onClick={onEdit}
              type="button"
            >
              Edit
            </button>
            <button
              className="admin-button admin-button-secondary"
              onClick={() =>
                fireTrigger.mutate({
                  triggerId: trigger.id,
                  prompt: `Run trigger ${trigger.name ?? trigger.type}.`,
                  payload: { triggerId: trigger.id, triggerType: trigger.type },
                })
              }
              type="button"
            >
              Trigger now
            </button>
            {trigger.status === 'paused' ? (
              <button
                className="admin-button admin-button-primary"
                onClick={() => resumeTrigger.mutate(trigger.id)}
                type="button"
              >
                Resume
              </button>
            ) : (
              <button
                className="admin-button admin-button-secondary"
                onClick={() => pauseTrigger.mutate(trigger.id)}
                type="button"
              >
                Pause
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {[
          ['Type', getTriggerTypeLabel(trigger)],
          ['Target', formatTriggerTarget(trigger, {
            agentsById,
            channelsById,
            workflowInstallationsById,
            workflowTemplatesById,
          })],
          ['Next run', formatTimestamp(trigger.nextRunAt)],
          ['Last fired', formatTimestamp(trigger.lastFiredAt)],
          ...triggerConfigRows,
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
        <div className={sectionTitle}>Recent deliveries</div>
        <div className="mt-3 grid gap-2">
          {history.map((delivery) => (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
              key={delivery.id}
            >
              <div className="flex items-center justify-between gap-3">
                <StatusPill tone={delivery.status === 'failed' ? 'danger' : 'muted'}>
                  {delivery.status}
                </StatusPill>
                <span className="text-xs text-[color:var(--tx3)]">
                  {formatTimestamp(delivery.createdAt)}
                </span>
              </div>
              <div className="mt-2 text-xs text-[color:var(--tx3)]">
                {delivery.source ?? 'manual'}
                {delivery.runId ? ` · run ${delivery.runId.slice(0, 8)}` : ''}
              </div>
              {delivery.errorMessage ? (
                <div className="mt-1 text-xs text-rose-300">
                  {delivery.errorMessage}
                </div>
              ) : null}
            </div>
          ))}
          {history.length === 0 ? (
            <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
              No deliveries yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export const TriggersPage = () => {
  const location = useLocation()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useTriggers(isOwner)
  const { data: scheduled = [] } = useUpcomingTriggers(isOwner)
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const { data: workflowInstallations = [] } = useWorkflowInstallations(isOwner)
  const { data: workflowTemplates = [] } = useWorkflowTemplates(isOwner)
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | undefined>(
    undefined,
  )
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingTriggerId, setEditingTriggerId] = useState<string | undefined>(undefined)

  const sortedTriggers = useMemo(
    () =>
      [...triggers].sort((left, right) =>
        (left.name ?? left.type).localeCompare(right.name ?? right.type),
      ),
    [triggers],
  )

  const scheduledTriggers = useMemo(
    () =>
      [...scheduled].sort((left, right) =>
        (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''),
      ),
    [scheduled],
  )

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const channelsById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  )
  const workflowInstallationsById = useMemo(
    () =>
      new Map(
        workflowInstallations.map((installation) => [installation.id, installation]),
      ),
    [workflowInstallations],
  )
  const workflowTemplatesById = useMemo(
    () => new Map(workflowTemplates.map((template) => [template.id, template])),
    [workflowTemplates],
  )

  useEffect(() => {
    const hashedTriggerId = parseTriggerHash(location.hash)
    if (hashedTriggerId) setSelectedTriggerId(hashedTriggerId)
  }, [location.hash])

  const activeCount = useMemo(
    () => sortedTriggers.filter((trigger) => trigger.status === 'active').length,
    [sortedTriggers],
  )

  const effectiveTriggerId =
    selectedTriggerId && sortedTriggers.some((trigger) => trigger.id === selectedTriggerId)
      ? selectedTriggerId
      : sortedTriggers[0]?.id

  const selectedTrigger = useMemo(
    () => sortedTriggers.find((trigger) => trigger.id === effectiveTriggerId),
    [effectiveTriggerId, sortedTriggers],
  )
  const editingTrigger = useMemo(
    () => sortedTriggers.find((trigger) => trigger.id === editingTriggerId),
    [editingTriggerId, sortedTriggers],
  )
  const defaultCreateTarget = useMemo(() => {
    if (!selectedTrigger) {
      return undefined
    }

    if (selectedTrigger.agentId) {
      return {
        targetKind: 'agent' as const,
        agentId: selectedTrigger.agentId,
        targetChannelId: selectedTrigger.targetChannelId,
      }
    }

    if (selectedTrigger.workflowInstallationId) {
      return {
        targetKind: 'workflow' as const,
        workflowInstallationId: selectedTrigger.workflowInstallationId,
      }
    }

    return undefined
  }, [selectedTrigger])

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  const columns = [
    <ColumnBrowserColumn
      headerAction={
        <button
          className="admin-button admin-button-primary"
          onClick={() => setCreateDialogOpen(true)}
          type="button"
        >
          New trigger
        </button>
      }
      key="triggers"
      title="All triggers"
    >
      <div className="grid gap-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className={sectionTitle}>Configured</div>
            <div className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {activeCount} active
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            {sortedTriggers.map((trigger) => (
              <ColumnBrowserItem
                caption={`Next run ${formatTimestamp(trigger.nextRunAt)}`}
                isSelected={trigger.id === effectiveTriggerId}
                key={trigger.id}
                meta={<StatusPill tone={getTriggerTone(trigger.status)}>{trigger.status}</StatusPill>}
                onClick={() => setSelectedTriggerId(trigger.id)}
                subtitle={`${formatTriggerTarget(trigger, {
                  agentsById,
                  channelsById,
                  workflowInstallationsById,
                  workflowTemplatesById,
                })} · ${getTriggerTypeLabel(trigger)}`}
                title={trigger.name ?? trigger.type}
              >
                {trigger.description ?? 'Ready to fire or schedule.'}
              </ColumnBrowserItem>
            ))}
            {sortedTriggers.length === 0 ? (
              <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
                No triggers yet.
              </div>
            ) : null}
          </div>
        </div>

        <div>
          <div className={sectionTitle}>Scheduled queue</div>
          <div className="mt-3 grid gap-2">
            {scheduledTriggers.map((trigger) => (
              <button
                className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2 text-left transition hover:bg-black/20"
                key={trigger.id}
                onClick={() => setSelectedTriggerId(trigger.id)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-white">
                      {trigger.name ?? trigger.type}
                    </div>
                    <div className="mt-1 text-xs text-[color:var(--tx3)]">
                      {getTriggerTypeLabel(trigger)} · {formatTimestamp(trigger.nextRunAt)}
                    </div>
                  </div>
                  <StatusPill tone={getTriggerTone(trigger.status)}>
                    {trigger.status}
                  </StatusPill>
                </div>
              </button>
            ))}
            {scheduledTriggers.length === 0 ? (
              <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
                No scheduled triggers in queue.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </ColumnBrowserColumn>,
  ]

  if (selectedTrigger) {
    columns.push(
      <ColumnBrowserColumn
        key={`trigger-${selectedTrigger.id}`}
        onBack={() => setSelectedTriggerId(undefined)}
        showBack={isMobile}
        title={selectedTrigger.name ?? selectedTrigger.type}
      >
        <TriggerDetail
          agentsById={agentsById}
          channelsById={channelsById}
          onEdit={() => setEditingTriggerId(selectedTrigger.id)}
          trigger={selectedTrigger}
          workflowInstallationsById={workflowInstallationsById}
          workflowTemplatesById={workflowTemplatesById}
        />
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={selectedTriggerId && selectedTrigger ? 1 : 0}
        columns={columns}
      />
      <TriggerEditorDialog
        agents={agents}
        channels={channels}
        defaultTarget={defaultCreateTarget}
        onClose={() => {
          setCreateDialogOpen(false)
          setEditingTriggerId(undefined)
        }}
        onSaved={(trigger) => {
          setSelectedTriggerId(trigger.id)
        }}
        open={createDialogOpen || Boolean(editingTrigger)}
        trigger={editingTrigger}
        workflowInstallations={workflowInstallations}
        workflowTemplates={workflowTemplates}
      />
    </div>
  )
}
