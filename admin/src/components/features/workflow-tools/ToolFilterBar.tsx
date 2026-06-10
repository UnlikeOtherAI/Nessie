import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'

/**
 * Filter pills above the registry list. Source / status pickers map 1:1 to
 * `/api/mcp/tools` query params so toggling a pill rebuilds the cache key
 * through the facade (no manual fetch).
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

const SOURCES: Array<ToolRegistrySource | undefined> = [
  undefined,
  'builtin',
  'custom',
  'mcp-remote',
  'interactive-session',
]

const STATUSES: Array<ToolRegistryEntryStatus | undefined> = [
  undefined,
  'active',
  'pending_review',
  'disabled',
]

const pillClass = (active: boolean) =>
  [
    'rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em]',
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
  <div className="grid gap-3">
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
        Source
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {SOURCES.map((value) => (
          <button
            className={pillClass(source === value)}
            key={value ?? 'all'}
            onClick={() => onSourceChange(value)}
            type="button"
          >
            {value ?? 'all'}
          </button>
        ))}
      </div>
    </div>
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
        Status
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {STATUSES.map((value) => (
          <button
            className={pillClass(status === value)}
            key={value ?? 'all'}
            onClick={() => onStatusChange(value)}
            type="button"
          >
            {value ?? 'all'}
          </button>
        ))}
      </div>
    </div>
    {tagOptions.length > 0 && (
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
          Tag
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className={pillClass(!tag)}
            onClick={() => onTagChange(undefined)}
            type="button"
          >
            all
          </button>
          {tagOptions.map((value) => (
            <button
              className={pillClass(tag === value)}
              key={value}
              onClick={() => onTagChange(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    )}
  </div>
)
