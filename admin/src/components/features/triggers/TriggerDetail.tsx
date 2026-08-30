import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  useDeleteTrigger,
  useFireTrigger,
  usePauseTrigger,
  useReauthorizeTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { getBaseUrl } from '../../../lib/api-client'
import { Notice } from '../../primitives/Notice'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import {
  TRIGGER_TYPE_ICONS,
  formatRelativeTime,
  formatTimestamp,
  formatTriggerTarget,
  getScheduleSummary,
  getTriggerEventNames,
  getTriggerHealthMessage,
  getTriggerTone,
  getTriggerTypeLabel,
  type TriggerRegistryMaps,
} from './trigger-presentation'

/**
 * Trigger detail. Each fact appears exactly once: the type lives in the
 * header (icon + label), the schedule in one definition row, and status in a
 * single pill. "Run now" is the sole primary action; destructive delete sits
 * apart from the routine controls and needs a second click.
 */

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

const DELIVERY_DOT: Record<string, string> = {
  delivered: 'var(--success-text)',
  failed: 'var(--danger-text)',
  pending: 'var(--warning-text)',
  skipped: 'var(--tx3)',
}

const FactRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 px-3 py-2.5">
    <dt className="flex-shrink-0 text-xs text-[color:var(--tx3)]">{label}</dt>
    <dd className="min-w-0 text-right text-sm text-[var(--tx)]">{value}</dd>
  </div>
)

export const TriggerDetail = ({ onDeleted, onEdit, registry, trigger }: TriggerDetailProps) => {
  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const reauthorizeTrigger = useReauthorizeTrigger()
  const fireTrigger = useFireTrigger()
  const deleteTrigger = useDeleteTrigger()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const { data: history = [] } = useTriggerHistory(trigger.id, 8)
  // Only while the schedule is actually stopped: a stale reason left over from a
  // repaired failure would otherwise keep claiming it is broken.
  // The server refuses a plain repair when the schedule belongs to somebody else
  // or was created in another workspace, and names which. Offering takeover only
  // then keeps the ordinary path one click and the attribution-moving path
  // deliberate.
  const needsTakeOver =
    actionError !== null
    && /belongs to somebody else|active workspace differs/.test(actionError)
  const healthMessage =
    trigger.status === 'needs_reauthorization' || trigger.status === 'error'
      ? getTriggerHealthMessage(trigger)
      : null

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

  const handleReauthorize = (takeOver = false) => {
    setActionError(null)
    reauthorizeTrigger.mutate(
      { triggerId: trigger.id, ...(takeOver ? { takeOver: true } : {}) },
      {
        onError: (error) =>
          setActionError(
            error instanceof Error ? error.message : 'Failed to reauthorize this schedule.',
          ),
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
  const eventNames = getTriggerEventNames(trigger)
  const nextRunRelative = formatRelativeTime(trigger.nextRunAt)

  return (
    <div className="grid max-w-3xl gap-5">
      {healthMessage ? (
        <div
          className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2.5"
          role="status"
        >
          <div className="text-sm font-medium text-[color:var(--danger-text)]">
            This schedule has stopped
          </div>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">{healthMessage}</p>
          {needsTakeOver ? (
            <button
              className="admin-button admin-button-secondary mt-2"
              disabled={reauthorizeTrigger.isPending}
              onClick={() => handleReauthorize(true)}
              type="button"
            >
              Take over and reauthorize
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Header: identity + status, one primary action */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
              <FontAwesomeIcon className="h-4 w-4" icon={TRIGGER_TYPE_ICONS[trigger.type]} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold text-[var(--tx)]">
                  {trigger.name ?? trigger.type}
                </h2>
                <Pill tone={getTriggerTone(trigger.status)}>
                  {trigger.status}
                </Pill>
              </div>
              <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                {getTriggerTypeLabel(trigger)}
              </div>
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            {trigger.status === 'needs_reauthorization' ? (
              <button
                className="admin-button admin-button-primary"
                disabled={reauthorizeTrigger.isPending}
                onClick={() => handleReauthorize()}
                type="button"
              >
                {reauthorizeTrigger.isPending ? 'Reauthorizing…' : 'Reauthorize'}
              </button>
            ) : null}
            <button
              className="admin-button admin-button-primary"
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
              className="admin-button admin-button-secondary"
              onClick={onEdit}
              type="button"
            >
              Edit
            </button>
          </div>
        </div>

        {trigger.description ? (
          <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
            {trigger.description}
          </p>
        ) : null}

        {fireTrigger.isSuccess && !fireTrigger.isPending ? (
          <Notice className="mt-3" radius="lg" size="sm" tone="success">
            Trigger fired — the run appears under recent deliveries below.
          </Notice>
        ) : null}
        {actionError ? (
          <Notice className="mt-3" radius="lg" size="sm" tone="danger">
            {actionError}
          </Notice>
        ) : null}
      </div>

      {/* Facts: one definition list, no repeated facts */}
      <dl className="divide-y divide-[color:var(--sep)] rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
        <FactRow label="Target" value={formatTriggerTarget(trigger, registry)} />
        <FactRow label="Schedule" value={getScheduleSummary(trigger)} />
        {trigger.nextRunAt || trigger.type === 'scheduled' || trigger.type === 'interval' ? (
          <FactRow
            label="Next run"
            value={
              trigger.nextRunAt
                ? `${formatTimestamp(trigger.nextRunAt)}${nextRunRelative ? ` · ${nextRunRelative}` : ''}`
                : '—'
            }
          />
        ) : null}
        <FactRow label="Last fired" value={formatTimestamp(trigger.lastFiredAt)} />
        {eventNames.length > 0 ? (
          <FactRow label="Events" value={eventNames.join(', ')} />
        ) : null}
      </dl>

      {trigger.type === 'webhook' ? (
        <section>
          <SectionLabel>Webhook endpoint</SectionLabel>
          <p className="mt-1 text-xs text-[color:var(--tx3)]">
            POST to this endpoint with the API key as a bearer token to fire
            the trigger.
          </p>
          <div className="mt-3 grid gap-3 rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
            <CopyField label="Endpoint" value={`${webhookBaseUrl}/api/triggers/webhook`} />
            {trigger.webhookApiKey ? (
              <CopyField label="API key" value={trigger.webhookApiKey} />
            ) : (
              <div className="text-xs text-[color:var(--tx3)]">
                No API key generated yet.
              </div>
            )}
          </div>
        </section>
      ) : null}

      <section>
        <SectionLabel>Recent deliveries</SectionLabel>
        {history.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[color:var(--sep)] px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
            No deliveries yet. Use “Run now” to test this trigger.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
            {history.map((delivery) => (
              <div className="px-3 py-2.5" key={delivery.id}>
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: DELIVERY_DOT[delivery.status] ?? 'var(--tx3)' }}
                  />
                  <span className="text-sm text-[var(--tx)]">{delivery.status}</span>
                  <span className="text-xs text-[color:var(--tx3)]">
                    {delivery.source ?? 'manual'}
                    {delivery.runId ? ` · run ${delivery.runId.slice(0, 8)}` : ''}
                  </span>
                  {/* The delivery reached a worker; whether the run then
                      succeeded is a different question, and the one the owner
                      is actually asking when a schedule looks broken. */}
                  {delivery.runStatus && delivery.runStatus !== 'completed' ? (
                    <Pill className="flex-shrink-0" radius="chip" size="sm" tone="danger" uppercase={false}>
                      run {delivery.runStatus}
                    </Pill>
                  ) : null}
                  <span className="ml-auto flex-shrink-0 text-xs tabular-nums text-[color:var(--tx3)]">
                    {formatTimestamp(delivery.createdAt)}
                  </span>
                </div>
                {delivery.errorMessage ? (
                  <div className="mt-1 pl-4 text-xs text-[var(--danger-text)]">
                    {delivery.errorMessage}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Destructive action, separated from routine controls */}
      <div className="flex justify-end border-t border-[color:var(--sep)] pt-4">
        <button
          className={[
            'admin-button',
            confirmingDelete
              ? 'border border-[var(--danger-border)] bg-[var(--danger-soft)] text-[var(--danger-text)]'
              : 'text-[color:var(--tx3)] hover:text-[var(--danger-text)]',
          ].join(' ')}
          disabled={deleteTrigger.isPending}
          onClick={handleDelete}
          type="button"
        >
          {deleteTrigger.isPending
            ? 'Deleting…'
            : confirmingDelete
              ? 'Confirm delete'
              : 'Delete trigger'}
        </button>
      </div>
    </div>
  )
}
