import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'
import { SegmentedControl } from '../../primitives/SegmentedControl'

/**
 * Tool list filters. Source is the primary mental model ("where does this
 * tool come from") so it gets the segmented strip; status and tag are
 * narrowing dimensions and collapse into quiet selects on one row.
 */

type ToolFilterBarProps = {
  onSourceChange: (next?: ToolRegistrySource) => void
  onStatusChange: (next?: ToolRegistryEntryStatus) => void
  onTagChange: (next?: string) => void
  source?: ToolRegistrySource
  status?: ToolRegistryEntryStatus
  tag?: string
  tagOptions: string[]
}

type SourceSegment = 'all' | ToolRegistrySource

const SOURCE_OPTIONS: Array<{ label: string; value: SourceSegment }> = [
  { label: 'All', value: 'all' },
  { label: 'Built-in', value: 'builtin' },
  { label: 'Custom', value: 'custom' },
  { label: 'MCP', value: 'mcp-remote' },
  { label: 'Session', value: 'interactive-session' },
]

const STATUS_OPTIONS: Array<{ label: string; value: '' | ToolRegistryEntryStatus }> = [
  { label: 'Any status', value: '' },
  { label: 'Active', value: 'active' },
  { label: 'Pending review', value: 'pending_review' },
  { label: 'Disabled', value: 'disabled' },
]

export const ToolFilterBar = ({
  onSourceChange,
  onStatusChange,
  onTagChange,
  source,
  status,
  tag,
  tagOptions,
}: ToolFilterBarProps) => (
  <div className="grid gap-2">
    <SegmentedControl<SourceSegment>
      ariaLabel="Filter by source"
      onChange={(next) => onSourceChange(next === 'all' ? undefined : next)}
      options={SOURCE_OPTIONS}
      value={source ?? 'all'}
    />
    <div className="flex gap-2">
      <select
        aria-label="Filter by status"
        className="admin-input flex-1 py-1.5 text-xs"
        onChange={(event) =>
          onStatusChange(
            event.target.value === ''
              ? undefined
              : (event.target.value as ToolRegistryEntryStatus),
          )
        }
        value={status ?? ''}
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {tagOptions.length > 0 ? (
        <select
          aria-label="Filter by tag"
          className="admin-input flex-1 py-1.5 text-xs"
          onChange={(event) => onTagChange(event.target.value || undefined)}
          value={tag ?? ''}
        >
          <option value="">All tags</option>
          {tagOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  </div>
)
