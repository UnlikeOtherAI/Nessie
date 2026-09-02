import type { ToolRegistryEntryStatus } from '@nessie/schemas'
import { TabBar } from '../../primitives/TabBar'

/**
 * Tool list filters. Source is the primary mental model ("where does this
 * tool come from") so it gets the segmented strip; status and tag are
 * narrowing dimensions and collapse into quiet selects on one row.
 */

type ToolFilterBarProps = {
  onSourceChange: (next: SourceSegment) => void
  onStatusChange: (next?: ToolRegistryEntryStatus) => void
  onTagChange: (next?: string) => void
  source: SourceSegment
  status?: ToolRegistryEntryStatus
  tag?: string
  tagOptions: string[]
}

// The strip's segments, and what `?source=` is validated against. 'all' is
// the strip's name for "no source narrowing" — the page maps it to undefined
// for the request. `executor` is a ToolRegistrySource with no segment here on
// purpose, so the union is spelled out rather than derived from the source
// type: a value the strip cannot show must not be reachable through `?source=`.
export const TOOL_SOURCE_SEGMENTS = [
  'all',
  'builtin',
  'custom',
  'mcp-remote',
  'interactive-session',
] as const

export type SourceSegment = (typeof TOOL_SOURCE_SEGMENTS)[number]

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
    <TabBar<SourceSegment>
      ariaLabel="Filter by source"
      fullWidth
      items={SOURCE_OPTIONS}
      onChange={onSourceChange}
      role="radiogroup"
      size="sm"
      value={source}
    />
    <div className="flex gap-2">
      <select
        aria-label="Filter by status"
        className="admin-input admin-input-compact flex-1"
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
          className="admin-input admin-input-compact flex-1"
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
