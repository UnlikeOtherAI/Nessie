import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  useDeleteTrigger,
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { getBaseUrl } from '../../../lib/api-client'
import { StatusPill } from '../../primitives/StatusPill'
import {
  TRIGGER_TYPE_ICONS,
  formatRelativeTime,
  formatTimestamp,
  formatTriggerTarget,
  getScheduleSummary,
  getTriggerConfigRows,
  getTriggerTone,
  getTriggerTypeLabel,
  sectionTitle,
  type TriggerRegistryMaps,
} from './trigger-presentation'

type TriggerDetailProps = {
  onDeleted: () => void
  onEdit: () => void
  registry: TriggerRegistryMaps
  trigger: AgentTriggerRecord
}

const CopyField = ({ label, value }: { label: string; value: string }) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <div className="grid gap-1">
      <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-[color:var(--sep)] bg-[var(--scrim-strong)] px-2 py-1.5 text-xs text-[color:var(--tx2)]">
          {value}
        </code>
        <button
          className="admin-button admin-button-secondary flex-shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true))
          }}
          type="button"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

const deliveryTone = (status: string) => {
  if (status === 'failed') return 'danger' as const
  if (status === 'delivered') return 'success' as const
  if (status === 'skipped') return 'muted' as const
  return 'warning' as const
}

export const TriggerDetail = ({ onDeleted, onEdit, registry, trigger }: TriggerDetailProps) => {
  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const fireTrigger = useFireTrigger()
  const deleteTrigger = useDeleteTrigger()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const { data: history = [] } = useTriggerHistory(trigger.id, 8)
  const triggerConfigRows = getTriggerConfigRows(trigger)

  // Reset transient state when switching triggers.
  useEffect(() => {
    setConfirmingDelete(false)
    setActionError(null)
  }, [trigger.id])

  const handleFire = () => {
    setActionError(null)
    fireTrigger.mutate(
      {
        triggerId: trigger.id,
        prompt: `Run trigger ${trigger.name ?? trigger.type}.`,
        payload: { triggerId: trigger.id, triggerType: trigger.type },
      },
      {
        onError: (error) =>
          setActionError(error instanceof Error ? error.message : 'Failed to fire trigger.'),
      },
    )
  }

  const handleDelete = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }

    setActionError(null)
    deleteTrigger.mutate(trigger.id, {
      onSuccess: () => onDeleted(),
      onError: (error) => {
        setConfirmingDelete(false)
        const message = error instanceof Error ? error.message : 'Failed to delete trigger.'
        setActionError(
          message.includes('TRIGGER_DELETE_BLOCKED') || message.includes('409')
            ? 'This trigger has delivery history and cannot be deleted. Pause it instead.'
            : message,
        )
      },
    })
  }

  const webhookBaseUrl = getBaseUrl() || window.location.origin.replace(/\/$/, '')

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
                <FontAwesomeIcon className="h-4 w-4" icon={TRIGGER_TYPE_ICONS[trigger.type]} />
              </div>
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-[var(--tx)]">
                {trigger.name ?? trigger.type}
              </h2>
              <StatusPill tone={getTriggerTone(trigger.status)}>
                {trigger.status}
              </StatusPill>
              {!trigger.enabled ? <StatusPill tone="muted">disabled</StatusPill> : null}
            </div>
            <div className="mt-3 text-sm text-[color:var(--tx2)]">
              {trigger.description ??
                `Target ${formatTriggerTarget(trigger, registry)} via ${getTriggerTypeLabel(
                  trigger,
                ).toLowerCase()}.`}
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
              disabled={fireTrigger.isPending}
              onClick={handleFire}
              type="button"
            >
              {fireTrigger.isPending ? 'Firing…' : 'Run now'}
            </button>
            {trigger.status === 'paused' ? (
              <button
                className="admin-button admin-button-secondary"
                disabled={resumeTrigger.isPending}
                onClick={() => resumeTrigger.mutate(trigger.id)}
                type="button"
              >
                Resume
              </button>
            ) : (
              <button
                className="admin-button admin-button-secondary"
                disabled={pauseTrigger.isPending}
                onClick={() => pauseTrigger.mutate(trigger.id)}
                type="button"
              >
                Pause
              </button>
            )}
            <button
              className={[
                'admin-button',
                confirmingDelete
                  ? 'border border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger-text)]'
                  : 'admin-button-secondary',
              ].join(' ')}
              disabled={deleteTrigger.isPending}
              onClick={handleDelete}
              type="button"
            >
              {deleteTrigger.isPending
                ? 'Deleting…'
                : confirmingDelete
                  ? 'Confirm delete'
                  : 'Delete'}
            </button>
          </div>
        </div>

        {fireTrigger.isSuccess && !fireTrigger.isPending ? (
          <div className="mt-3 rounded-lg border border-[var(--success-border)] bg-[var(--success-soft)] px-3 py-2 text-xs text-[var(--success-text)]">
            Trigger fired — check recent deliveries below for the run.
          </div>
        ) : null}
        {actionError ? (
          <div className="mt-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger-text)]">
            {actionError}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {[
          ['Type', getTriggerTypeLabel(trigger)],
          ['Target', formatTriggerTarget(trigger, registry)],
          ['Schedule', getScheduleSummary(trigger)],
          [
            'Next run',
            trigger.nextRunAt
              ? `${formatTimestamp(trigger.nextRunAt)} (${formatRelativeTime(trigger.nextRunAt) ?? ''})`
              : '—',
          ],
          ['Last fired', formatTimestamp(trigger.lastFiredAt)],
          ...triggerConfigRows,
        ].map(([label, value]) => (
          <div
            className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3"
            key={label}
          >
            <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              {label}
            </div>
            <div className="mt-2 text-sm text-[var(--tx)]">{value}</div>
          </div>
        ))}
      </div>

      {trigger.type === 'webhook' ? (
        <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
          <div className={sectionTitle}>Webhook endpoint</div>
          <p className="mt-2 text-xs text-[color:var(--tx3)]">
            POST to this endpoint with the API key as a bearer token to fire the
            trigger.
          </p>
          <div className="mt-3 grid gap-3">
            <CopyField label="Endpoint" value={`${webhookBaseUrl}/api/triggers/webhook`} />
            {trigger.webhookApiKey ? (
              <CopyField label="API key" value={trigger.webhookApiKey} />
            ) : (
              <div className="text-xs text-[color:var(--tx3)]">
                No API key generated yet.
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className={sectionTitle}>Recent deliveries</div>
        <div className="mt-3 grid gap-2">
          {history.map((delivery) => (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2"
              key={delivery.id}
            >
              <div className="flex items-center justify-between gap-3">
                <StatusPill tone={deliveryTone(delivery.status)}>
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
                <div className="mt-1 text-xs text-[var(--danger-text)]">
                  {delivery.errorMessage}
                </div>
              ) : null}
            </div>
          ))}
          {history.length === 0 ? (
            <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
              No deliveries yet. Use “Run now” to test this trigger.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
