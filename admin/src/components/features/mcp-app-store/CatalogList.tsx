import { ColumnBrowserItem } from '../../shared/column-browser/ColumnBrowserItem'
import { Pill } from '../../primitives/Pill'
import type { McpCatalogEntryRecord } from '../../../facades/mcp-catalog/hooks'

/**
 * Catalog list used as the left column of the MCP App Store admin surface.
 * Pure presentational — the page owns selection state and mutations.
 */
type CatalogListProps = {
  entries: McpCatalogEntryRecord[]
  onSelect: (entryId: string) => void
  selectedId?: string
}

const STATUS_TONE = {
  draft: 'warning',
  pending_approval: 'accent',
  published: 'success',
  rejected: 'danger',
  deprecated: 'muted',
} as const

export const CatalogList = ({
  entries,
  onSelect,
  selectedId,
}: CatalogListProps) => {
  if (entries.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
        No catalog entries yet. Use "Add MCP server" to register one.
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {entries.map((entry) => (
        <ColumnBrowserItem
          caption={
            entry.vendor
              ? `${entry.protocol.toUpperCase()} · ${entry.vendor}`
              : entry.protocol.toUpperCase()
          }
          isSelected={entry.id === selectedId}
          key={entry.id}
          meta={
            <span className="flex items-center gap-1">
              {entry.locked ? <Pill tone="muted">🔒 locked</Pill> : null}
              <Pill tone={STATUS_TONE[entry.status]}>
                {entry.status}
              </Pill>
            </span>
          }
          onClick={() => onSelect(entry.id)}
          subtitle={`auth: ${entry.authMethod}`}
          title={entry.label}
        >
          {entry.description || entry.name}
        </ColumnBrowserItem>
      ))}
    </div>
  )
}
