import {
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { StatusPill } from '../../primitives/StatusPill'
import {
  formatTimestamp,
  formatTriggerTarget,
  getTriggerConfigRows,
  getTriggerTone,
  getTriggerTypeLabel,
  sectionTitle,
  type TriggerRegistryMaps,
} from '../../../pages/triggers/trigger-presentation'

type TriggerDetailProps = {
  onEdit: () => void
  registry: TriggerRegistryMaps
  trigger: AgentTriggerRecord
}

export const TriggerDetail = ({ onEdit, registry, trigger }: TriggerDetailProps) => {
  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const fireTrigger = useFireTrigger()
  const { data: history = [] } = useTriggerHistory(trigger.id, 8)
  const triggerConfigRows = getTriggerConfigRows(trigger)

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-[var(--tx)]">
                {trigger.name ?? trigger.type}
              </h2>
              <StatusPill tone={getTriggerTone(trigger.status)}>
                {trigger.status}
              </StatusPill>
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
          ['Target', formatTriggerTarget(trigger, registry)],
          ['Next run', formatTimestamp(trigger.nextRunAt)],
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

      <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
        <div className={sectionTitle}>Recent deliveries</div>
        <div className="mt-3 grid gap-2">
          {history.map((delivery) => (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2"
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
                <div className="mt-1 text-xs text-[var(--danger-text)]">
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
