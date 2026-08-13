import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { ReactNode } from 'react'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import type {
  TriggerStatusCounts,
  TriggerStatusFilter,
  TriggerTypeFilter,
} from '../../../pages/triggers/useTriggersPageState'
import { SegmentedControl } from '../../primitives/SegmentedControl'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import {
  TRIGGER_TYPE_ICONS,
  formatRelativeTime,
  formatTriggerTarget,
  getScheduleSummary,
  getTriggerStatusColor,
  type TriggerRegistryMaps,
} from './trigger-presentation'

/**
 * Trigger list: one flat, next-run-ordered group of rows. Status is a colour
 * dot (the detail header carries the full pill), the type is an icon, and the
 * second line compresses schedule + target into a single scan line. Filters
 * are one segmented status strip (the operational dimension, with counts)
 * plus a quiet type select (a narrowing dimension, rarely used).
 */

type TriggerListColumnProps = {
  effectiveTriggerId?: string
  filteredTriggers: AgentTriggerRecord[]
  leading?: ReactNode
  onCreate: () => void
  onSearchChange: (query: string) => void
  onSelect: (triggerId: string) => void
  onStatusFilterChange: (filter: TriggerStatusFilter) => void
  onTypeFilterChange: (filter: TriggerTypeFilter) => void
  registry: TriggerRegistryMaps
  searchQuery: string
  statusCounts: TriggerStatusCounts
  statusFilter: TriggerStatusFilter
  totalCount: number
  typeFilter: TriggerTypeFilter
}

const TYPE_OPTIONS: Array<{ label: string; value: TriggerTypeFilter }> = [
  { label: 'All types', value: 'all' },
  { label: 'Manual', value: 'manual' },
  { label: 'Schedule', value: 'scheduled' },
  { label: 'Interval', value: 'interval' },
  { label: 'Webhook', value: 'webhook' },
  { label: 'Event', value: 'event' },
]

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
  const nextRun = trigger.enabled ? formatRelativeTime(trigger.nextRunAt) : undefined

  return (
    <button
      className={[
        'w-full border-l-2 px-3 py-2.5 text-left transition-colors',
        isSelected
          ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
          : 'border-transparent hover:bg-[var(--overlay-weak)]',
      ].join(' ')}
      onClick={() => onSelect(trigger.id)}
      type="button"
    >
      <div className="flex items-center gap-2">
        <FontAwesomeIcon
          className="h-3 w-3 flex-shrink-0 text-[color:var(--tx3)]"
          icon={TRIGGER_TYPE_ICONS[trigger.type]}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--tx)]">
          {trigger.name ?? trigger.type}
        </span>
        {nextRun ? (
          <span className="flex-shrink-0 text-[11px] tabular-nums text-[color:var(--tx3)]">
            {nextRun}
          </span>
        ) : null}
        <span
          aria-label={`Status: ${trigger.status}`}
          className="h-2 w-2 flex-shrink-0 rounded-full"
          role="img"
          style={{ background: getTriggerStatusColor(trigger.status) }}
          title={trigger.status}
        />
      </div>
      <div className="mt-0.5 truncate pl-5 text-xs text-[color:var(--tx3)]">
        {getScheduleSummary(trigger)} · {formatTriggerTarget(trigger, registry)}
      </div>
    </button>
  )
}

export const TriggerListColumn = ({
  effectiveTriggerId,
  filteredTriggers,
  leading,
  onCreate,
  onSearchChange,
  onSelect,
  onStatusFilterChange,
  onTypeFilterChange,
  registry,
  searchQuery,
  statusCounts,
  statusFilter,
  totalCount,
  typeFilter,
}: TriggerListColumnProps) => (
  <ColumnBrowserColumn
    leading={leading}
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
    title="Triggers"
  >
    <div className="grid gap-3">
      <input
        autoComplete="off"
        className="admin-input"
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search triggers…"
        type="search"
        value={searchQuery}
      />

      <SegmentedControl
        ariaLabel="Filter by status"
        onChange={onStatusFilterChange}
        options={[
          { label: 'All', value: 'all', count: statusCounts.all },
          { label: 'Active', value: 'active', count: statusCounts.active },
          { label: 'Paused', value: 'paused', count: statusCounts.paused },
          { label: 'Error', value: 'error', count: statusCounts.error },
        ]}
        value={statusFilter}
      />

      <select
        aria-label="Filter by type"
        className="admin-input admin-input-compact"
        onChange={(event) => onTypeFilterChange(event.target.value as TriggerTypeFilter)}
        value={typeFilter}
      >
        {TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {filteredTriggers.length === 0 ? (
        <div className="py-10 text-center text-sm text-[color:var(--tx3)]">
          {totalCount === 0
            ? 'No triggers yet. Create one to wake an agent or workflow automatically.'
            : 'No triggers match the current filters.'}
        </div>
      ) : (
        <div className="divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
          {filteredTriggers.map((trigger) => (
            <TriggerRow
              isSelected={trigger.id === effectiveTriggerId}
              key={trigger.id}
              onSelect={onSelect}
              registry={registry}
              trigger={trigger}
            />
          ))}
        </div>
      )}
    </div>
  </ColumnBrowserColumn>
)
