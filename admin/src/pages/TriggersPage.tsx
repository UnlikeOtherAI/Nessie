import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
  useTriggers,
  useUpcomingTriggers,
} from '../facades/triggers/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { AgentTriggerRecord } from '../lib/api-client'
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

const formatTriggerTarget = (trigger: {
  agentId?: string
  workflowInstallationId?: string
}): string => {
  if (trigger.agentId) return `agent ${trigger.agentId.slice(0, 8)}`
  if (trigger.workflowInstallationId) {
    return `workflow ${trigger.workflowInstallationId.slice(0, 8)}`
  }
  return 'unassigned'
}

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

type TriggerDetailProps = {
  trigger: AgentTriggerRecord
}

const TriggerDetail = ({ trigger }: TriggerDetailProps) => {
  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const fireTrigger = useFireTrigger()
  const { data: history = [] } = useTriggerHistory(trigger.id, 8)

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
                `Target ${formatTriggerTarget(trigger)} via ${trigger.type}.`}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
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
          ['Type', trigger.type],
          ['Target', formatTriggerTarget(trigger)],
          ['Next run', formatTimestamp(trigger.nextRunAt)],
          ['Last fired', formatTimestamp(trigger.lastFiredAt)],
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
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | undefined>(
    undefined,
  )

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
        <div className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
          {activeCount} active
        </div>
      }
      key="triggers"
      title="All triggers"
    >
      <div className="grid gap-6">
        <div>
          <div className={sectionTitle}>Configured</div>
          <div className="mt-3 grid gap-3">
            {sortedTriggers.map((trigger) => (
              <ColumnBrowserItem
                caption={`Next run ${formatTimestamp(trigger.nextRunAt)}`}
                isSelected={trigger.id === effectiveTriggerId}
                key={trigger.id}
                meta={<StatusPill tone={getTriggerTone(trigger.status)}>{trigger.status}</StatusPill>}
                onClick={() => setSelectedTriggerId(trigger.id)}
                subtitle={`${formatTriggerTarget(trigger)} · ${trigger.type}`}
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
                      {trigger.type} · {formatTimestamp(trigger.nextRunAt)}
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
        <TriggerDetail trigger={selectedTrigger} />
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={selectedTriggerId && selectedTrigger ? 1 : 0}
        columns={columns}
      />
    </div>
  )
}
