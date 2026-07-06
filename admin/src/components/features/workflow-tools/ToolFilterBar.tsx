import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'

/**
 * Compact filter bar rendered above the tool list. Source / status pills map
 * 1:1 to `/api/mcp/tools` query params so toggling rebuilds the cache key
 * through the facade; the tag filter narrows client-side.
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

const SOURCES: Array<{ label: string; value?: ToolRegistrySource }> = [
  { label: 'All sources' },
  { label: 'Built-in', value: 'builtin' },
  { label: 'Custom', value: 'custom' },
  { label: 'MCP', value: 'mcp-remote' },
  { label: 'Session', value: 'interactive-session' },
]

const STATUSES: Array<{ label: string; value?: ToolRegistryEntryStatus }> = [
  { label: 'Any status' },
  { label: 'Active', value: 'active' },
  { label: 'Pending review', value: 'pending_review' },
  { label: 'Disabled', value: 'disabled' },
]

const pillClass = (active: boolean) =>
  [
    'rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] transition',
    active
      ? 'border-[color:var(--accent)] bg-[var(--accent-soft)] text-[var(--tx)]'
      : 'border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
  ].join(' ')

export const ToolFilterBar = ({
  onSourceChange,
  onStatusChange,
  onTagChange,
  source,
  status,
  tag,
  tagOptions,
}: ToolFilterBarProps) => (
  <div className="grid gap-1.5">
    <div className="flex flex-wrap gap-1.5">
      {SOURCES.map((option) => (
        <button
          className={pillClass(source === option.value)}
          key={option.value ?? 'all'}
          onClick={() => onSourceChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
    <div className="flex flex-wrap items-center gap-1.5">
      {STATUSES.map((option) => (
        <button
          className={pillClass(status === option.value)}
          key={option.value ?? 'all'}
          onClick={() => onStatusChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
      {tagOptions.length > 0 && (
        <select
          aria-label="Filter by tag"
          className="admin-input ml-auto w-auto py-1 text-xs"
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
      )}
    </div>
  </div>
)
