import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import type {
  TriggerStatusFilter,
  TriggerTypeFilter,
} from '../../../pages/triggers/useTriggersPageState'
import { StatusPill } from '../../primitives/StatusPill'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import {
  TRIGGER_TYPE_ICONS,
  formatRelativeTime,
  formatTriggerTarget,
  getScheduleSummary,
  getTriggerTone,
  sectionTitle,
  type TriggerRegistryMaps,
} from './trigger-presentation'

type TriggerListColumnProps = {
  activeCount: number
  effectiveTriggerId?: string
  filteredTriggers: AgentTriggerRecord[]
  onCreate: () => void
  onSearchChange: (query: string) => void
  onSelect: (triggerId: string) => void
  onStatusFilterChange: (filter: TriggerStatusFilter) => void
  onTypeFilterChange: (filter: TriggerTypeFilter) => void
  registry: TriggerRegistryMaps
  searchQuery: string
  statusFilter: TriggerStatusFilter
  totalCount: number
  typeFilter: TriggerTypeFilter
  upcomingTriggers: AgentTriggerRecord[]
}

const STATUS_FILTERS: Array<{ label: string; value: TriggerStatusFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
  { label: 'Error', value: 'error' },
]

const TYPE_FILTERS: Array<{ label: string; value: TriggerTypeFilter }> = [
  { label: 'Any type', value: 'all' },
  { label: 'Manual', value: 'manual' },
  { label: 'Schedule', value: 'scheduled' },
  { label: 'Interval', value: 'interval' },
  { label: 'Webhook', value: 'webhook' },
  { label: 'Event', value: 'event' },
]

const filterPillClass = (active: boolean) =>
  [
    'rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] transition',
    active
      ? 'border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--tx)]'
      : 'border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
  ].join(' ')

const TriggerRow = ({
  isSelected,
  onSelect,
  registry,
  trigger,
}: {
  isSelected: boolean
  onSelect: (triggerId: string) => void
  registry: TriggerRegistryMaps
  trigger: AgentTriggerRecord
}) => {
  const nextRun = formatRelativeTime(trigger.nextRunAt)

  return (
    <button
      className={[
        'w-full rounded-xl border p-3 text-left transition',
        isSelected
          ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
          : 'border-[color:var(--sep)] bg-[var(--scrim-weak)] hover:bg-[var(--scrim)]',
      ].join(' ')}
      onClick={() => onSelect(trigger.id)}
      type="button"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
          <FontAwesomeIcon className="h-3.5 w-3.5" icon={TRIGGER_TYPE_ICONS[trigger.type]} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate font-semibold text-[var(--tx)]">
              {trigger.name ?? trigger.type}
            </div>
            <StatusPill tone={getTriggerTone(trigger.status)}>{trigger.status}</StatusPill>
          </div>
          <div className="mt-1 truncate text-xs text-[color:var(--tx3)]">
            {formatTriggerTarget(trigger, registry)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[color:var(--tx2)]">
            <span>{getScheduleSummary(trigger)}</span>
            {nextRun ? (
              <span className="text-[color:var(--tx3)]">· next {nextRun}</span>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  )
}

export const TriggerListColumn = ({
  activeCount,
  effectiveTriggerId,
  filteredTriggers,
  onCreate,
  onSearchChange,
  onSelect,
  onStatusFilterChange,
  onTypeFilterChange,
  registry,
  searchQuery,
  statusFilter,
  totalCount,
  typeFilter,
  upcomingTriggers,
}: TriggerListColumnProps) => {
  const isFiltering =
    searchQuery.trim().length > 0 || statusFilter !== 'all' || typeFilter !== 'all'

  return (
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
      title={`Triggers (${activeCount}/${totalCount} active)`}
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <input
            autoComplete="off"
            className="admin-input"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search by name, target or type…"
            type="search"
            value={searchQuery}
          />
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((filter) => (
              <button
                className={filterPillClass(statusFilter === filter.value)}
                key={filter.value}
                onClick={() => onStatusFilterChange(filter.value)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TYPE_FILTERS.map((filter) => (
              <button
                className={filterPillClass(typeFilter === filter.value)}
                key={filter.value}
                onClick={() => onTypeFilterChange(filter.value)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {!isFiltering && upcomingTriggers.length > 0 ? (
          <div>
            <div className={sectionTitle}>Up next</div>
            <div className="mt-2 grid gap-1.5">
              {upcomingTriggers.map((trigger) => (
                <button
                  className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-1.5 text-left transition hover:bg-[var(--scrim)]"
                  key={`upcoming-${trigger.id}`}
                  onClick={() => onSelect(trigger.id)}
                  type="button"
                >
                  <span className="min-w-0 truncate text-sm text-[var(--tx)]">
                    {trigger.name ?? trigger.type}
                  </span>
                  <span className="flex-shrink-0 text-xs text-[color:var(--tx3)]">
                    {formatRelativeTime(trigger.nextRunAt) ?? '—'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <div className={sectionTitle}>
            {isFiltering ? `Matching (${filteredTriggers.length})` : 'All triggers'}
          </div>
          <div className="mt-2 grid gap-2">
            {filteredTriggers.map((trigger) => (
              <TriggerRow
                isSelected={trigger.id === effectiveTriggerId}
                key={trigger.id}
                onSelect={onSelect}
                registry={registry}
                trigger={trigger}
              />
            ))}
            {filteredTriggers.length === 0 ? (
              <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
                {totalCount === 0
                  ? 'No triggers yet. Create one to wake an agent or workflow automatically.'
                  : 'No triggers match the current filters.'}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </ColumnBrowserColumn>
  )
}
