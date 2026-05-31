import type { AgentTriggerRecord } from '../../../lib/api-client'
import { StatusPill } from '../../primitives/StatusPill'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserItem } from '../../shared/column-browser/ColumnBrowserItem'
import {
  formatTimestamp,
  formatTriggerTarget,
  getTriggerTone,
  getTriggerTypeLabel,
  sectionTitle,
  type TriggerRegistryMaps,
} from '../../../pages/triggers/trigger-presentation'

type TriggerListColumnProps = {
  activeCount: number
  effectiveTriggerId?: string
  onCreate: () => void
  onSelect: (triggerId: string) => void
  registry: TriggerRegistryMaps
  scheduledTriggers: AgentTriggerRecord[]
  sortedTriggers: AgentTriggerRecord[]
}

export const TriggerListColumn = ({
  activeCount,
  effectiveTriggerId,
  onCreate,
  onSelect,
  registry,
  scheduledTriggers,
  sortedTriggers,
}: TriggerListColumnProps) => (
  <ColumnBrowserColumn
    headerAction={
      <button
        className="admin-button admin-button-primary"
        onClick={onCreate}
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
              onClick={() => onSelect(trigger.id)}
              subtitle={`${formatTriggerTarget(trigger, registry)} · ${getTriggerTypeLabel(
                trigger,
              )}`}
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
              onClick={() => onSelect(trigger.id)}
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
  </ColumnBrowserColumn>
)
