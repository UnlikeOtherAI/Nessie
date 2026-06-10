import { ToolBadge } from '../../shared/ToolBadge'
import { ToolCategoryIcon } from '../../shared/ToolCategoryIcon'
import { ToolPermissionPill } from '../../shared/ToolPermissionPill'
import { ToolTransportPill } from '../../shared/ToolTransportPill'
import type { McpToolRegistryRecord } from '../../../facades/tool-grants/hooks'

/**
 * Tool list rendered on the left of the Workflows > Tools page. Uses the
 * four mandated `Tool*` primitives end-to-end (per §8 of provider-system-and-
 * frontend-architecture.md) so the row is consistent with anywhere else tools
 * appear in the product.
 */

type ToolListProps = {
  onSelect: (tool: McpToolRegistryRecord) => void
  selectedId?: string
  tools: McpToolRegistryRecord[]
}

export const ToolList = ({ onSelect, selectedId, tools }: ToolListProps) => {
  if (tools.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
        No tools match the current filter.
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {tools.map((tool) => (
        <button
          className={[
            'w-full rounded-xl border p-3 text-left transition',
            tool.id === selectedId
              ? 'border-[var(--success-border)] bg-[var(--success-soft)]'
              : 'border-[color:var(--sep)] bg-[var(--scrim-weak)] hover:bg-[var(--scrim)]',
          ].join(' ')}
          key={tool.id}
          onClick={() => onSelect(tool)}
          type="button"
        >
          <div className="flex items-start gap-3">
            <ToolCategoryIcon source={tool.source} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold text-[var(--tx)]">
                  {tool.label}
                </span>
                <ToolBadge label={tool.source} source={tool.source} />
                <ToolTransportPill transport={tool.transport} />
                <ToolPermissionPill status={tool.status} />
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">
                {tool.toolId} · v{tool.version}
              </div>
              {tool.description ? (
                <div className="mt-2 text-sm text-[color:var(--tx2)]">
                  {tool.description}
                </div>
              ) : null}
              {tool.tags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {tool.tags.map((tag) => (
                    <span
                      className={[
                        'rounded-full border border-[color:var(--sep)] bg-[var(--scrim)]',
                        'px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]',
                        'text-[color:var(--tx3)]',
                      ].join(' ')}
                      key={tag}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
