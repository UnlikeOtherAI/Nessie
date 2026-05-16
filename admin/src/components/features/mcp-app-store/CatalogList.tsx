import { ColumnBrowserItem } from '../../shared/column-browser/ColumnBrowserItem'
import { StatusPill } from '../../primitives/StatusPill'
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
  published: 'success',
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
            <StatusPill tone={STATUS_TONE[entry.status]}>
              {entry.status}
            </StatusPill>
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
