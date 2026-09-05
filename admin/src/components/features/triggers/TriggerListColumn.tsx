import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { UseQueryResult } from '@tanstack/react-query'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import type {
  TriggerStatusCounts,
  TriggerStatusFilter,
  TriggerTypeFilter,
} from '../../../pages/triggers/useTriggersPageState'
import { Skeleton } from '../../primitives/Skeleton'
import { TabBar } from '../../primitives/TabBar'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { OwnerGate } from '../../shared/OwnerGate'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
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
  isPending: boolean
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
  triggersQuery: UseQueryResult<AgentTriggerRecord[]>
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

const TRIGGER_LIST_ACTIONS = (onCreate: () => void): PageHeaderAction[] => [
  {
    id: 'new-trigger',
    label: 'New trigger',
    onSelect: onCreate,
    primary: true,
    priority: 100,
  },
]

export const TriggerListColumn = ({
  effectiveTriggerId,
  filteredTriggers,
  isPending,
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
  triggersQuery,
  typeFilter,
}: TriggerListColumnProps) => (
  <ColumnBrowserColumn
    actions={TRIGGER_LIST_ACTIONS(onCreate)}
    key="triggers"
    screen
    title="Triggers"
  >
    {/* The header is always rendered: a refusal is a state of this screen,
        not a screen of its own, so Back — and the h1 the settle focuses —
        never disappears with it (docs/navigation/deep-links-and-headers.md
        §9). Only the body underneath is owner-gated. */}
    <OwnerGate>
      <div className="grid gap-3">
        <input
          autoComplete="off"
          className="admin-input"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search triggers…"
          type="search"
          value={searchQuery}
        />

        <TabBar
          ariaLabel="Filter by status"
          fullWidth
          items={[
            { count: statusCounts.all, label: 'All', value: 'all' },
            { count: statusCounts.active, label: 'Active', value: 'active' },
            { count: statusCounts.paused, label: 'Paused', value: 'paused' },
            { count: statusCounts.error, label: 'Error', value: 'error' },
          ]}
          onChange={onStatusFilterChange}
          role="radiogroup"
          size="sm"
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

        {/* A list whose shape is already known shows that shape while it loads
            rather than the word Loading (docs/navigation/overview.md §14); the kit's
            QueryState still owns the error and empty lines below it. */}
        {isPending ? (
          <Skeleton className="py-4" count={4} variant="list" />
        ) : (
          <QueryState
            emptyLabel={
              totalCount === 0
                ? 'No triggers yet. Create one to wake an agent or workflow automatically.'
                : 'No triggers match the current filters.'
            }
            errorLabel="Triggers could not be loaded."
            isEmpty={filteredTriggers.length === 0}
            loadingLabel="Loading triggers…"
            query={triggersQuery}
          >
            {() => (
              <RowList label="Triggers">
                {filteredTriggers.map((trigger) => {
                  const nextRun = trigger.enabled ? formatRelativeTime(trigger.nextRunAt) : undefined
                  return (
                    <Row
                      key={trigger.id}
                      leading={
                        <FontAwesomeIcon
                          className="h-3 w-3 text-[color:var(--tx3)]"
                          icon={TRIGGER_TYPE_ICONS[trigger.type]}
                        />
                      }
                      onClick={() => onSelect(trigger.id)}
                      selected={trigger.id === effectiveTriggerId}
                      subtitle={`${getScheduleSummary(trigger)} · ${formatTriggerTarget(trigger, registry)}`}
                      title={trigger.name ?? trigger.type}
                      trailing={
                        <>
                          {nextRun ? (
                            <span className="text-[11px] tabular-nums text-[color:var(--tx3)]">
                              {nextRun}
                            </span>
                          ) : null}
                          <span
                            aria-label={`Status: ${trigger.status}`}
                            className="h-2 w-2 rounded-full"
                            role="img"
                            style={{ background: getTriggerStatusColor(trigger.status) }}
                            title={trigger.status}
                          />
                        </>
                      }
                    />
                  )
                })}
              </RowList>
            )}
          </QueryState>
        )}
      </div>
    </OwnerGate>
  </ColumnBrowserColumn>
)
