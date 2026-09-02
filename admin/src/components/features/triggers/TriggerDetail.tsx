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
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { CopyField } from '../../shared/CopyField'
import { EmptyState } from '../../shared/EmptyState'
import { KeyValueList } from '../../shared/KeyValueList'
import { Row, RowList } from '../../shared/RowList'
import { Notice } from '../../primitives/Notice'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import {
  TRIGGER_TYPE_ICONS,
  formatRelativeTime,
  formatTimestamp,
  formatTriggerTarget,
  getDeliveryStatusColor,
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

export const TriggerDetail = ({ onDeleted, onEdit, registry, trigger }: TriggerDetailProps) => {
  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const reauthorizeTrigger = useReauthorizeTrigger()
  const fireTrigger = useFireTrigger()
  const deleteTrigger = useDeleteTrigger()
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
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
    setConfirmDeleteOpen(false)
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
    setActionError(null)
    deleteTrigger.mutate(trigger.id, {
      onSuccess: () => onDeleted(),
      onError: (error) => {
        setConfirmDeleteOpen(false)
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
      <KeyValueList
        items={[
          { label: 'Target', value: formatTriggerTarget(trigger, registry) },
          { label: 'Schedule', value: getScheduleSummary(trigger) },
          ...(trigger.nextRunAt || trigger.type === 'scheduled' || trigger.type === 'interval'
            ? [
                {
                  label: 'Next run',
                  value: trigger.nextRunAt
                    ? `${formatTimestamp(trigger.nextRunAt)}${nextRunRelative ? ` · ${nextRunRelative}` : ''}`
                    : '—',
                },
              ]
            : []),
          { label: 'Last fired', value: formatTimestamp(trigger.lastFiredAt) },
          ...(eventNames.length > 0
            ? [{ label: 'Events', value: eventNames.join(', ') }]
            : []),
        ]}
      />

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
          <EmptyState className="mt-3">
            No deliveries yet. Use “Run now” to test this trigger.
          </EmptyState>
        ) : (
          <RowList className="mt-3" label="Recent deliveries">
            {history.map((delivery) => (
              <Row
                key={delivery.id}
                leading={
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: getDeliveryStatusColor(delivery.status) }}
                  />
                }
                title={
                  <span className="flex items-center gap-2">
                    <span>{delivery.status}</span>
                    <span className="font-normal text-xs text-[color:var(--tx3)]">
                      {delivery.source ?? 'manual'}
                      {delivery.runId ? ` · run ${delivery.runId.slice(0, 8)}` : ''}
                    </span>
                    {/* The delivery reached a worker; whether the run then
                        succeeded is a different question, and the one the
                        owner is actually asking when a schedule looks broken. */}
                    {delivery.runStatus && delivery.runStatus !== 'completed' ? (
                      <Pill radius="chip" size="sm" tone="danger" uppercase={false}>
                        run {delivery.runStatus}
                      </Pill>
                    ) : null}
                  </span>
                }
                trailing={
                  <span className="text-xs tabular-nums text-[color:var(--tx3)]">
                    {formatTimestamp(delivery.createdAt)}
                  </span>
                }
              >
                {delivery.errorMessage ? (
                  <div className="mt-1 text-xs text-[var(--danger-text)]">
                    {delivery.errorMessage}
                  </div>
                ) : null}
              </Row>
            ))}
          </RowList>
        )}
      </section>

      {/* Destructive action, separated from routine controls */}
      <div className="flex justify-end border-t border-[color:var(--sep)] pt-4">
        <button
          className="admin-button text-[color:var(--tx3)] hover:text-[var(--danger-text)]"
          disabled={deleteTrigger.isPending}
          onClick={() => setConfirmDeleteOpen(true)}
          type="button"
        >
          {deleteTrigger.isPending ? 'Deleting…' : 'Delete trigger'}
        </button>
      </div>

      <ConfirmDialog
        body="Deleting a trigger cannot be undone. It refuses when the trigger has delivery history — pause it instead."
        confirmLabel="Delete trigger"
        destructive
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={handleDelete}
        open={confirmDeleteOpen}
        pending={deleteTrigger.isPending}
        title="Delete this trigger?"
      />
    </div>
  )
}
