import { ToolBadge } from '../../shared/ToolBadge'
import { ToolPermissionPill } from '../../shared/ToolPermissionPill'
import { ToolTransportPill } from '../../shared/ToolTransportPill'
import type { McpToolRegistryRecord } from '../../../facades/tool-grants/hooks'

/**
 * Flat tool rows in one grouped container. Badges are exception-based: a
 * built-in, direct-transport, active tool (the overwhelming default) renders
 * no badges at all — a badge appearing means the tool deviates and deserves
 * attention. Full metadata lives in the detail pane.
 */

type ToolListProps = {
  onSelect: (tool: McpToolRegistryRecord) => void
  selectedId?: string
  tools: McpToolRegistryRecord[]
}

export const ToolList = ({ onSelect, selectedId, tools }: ToolListProps) => {
  if (tools.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-[color:var(--tx3)]">
        No tools match the current filter.
      </div>
    )
  }

  return (
    <div className="divide-y divide-[color:var(--sep)] overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]">
      {tools.map((tool) => (
        <button
          className={[
            'w-full border-l-2 px-3 py-2.5 text-left transition-colors',
            tool.id === selectedId
              ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
              : 'border-transparent hover:bg-[var(--overlay-weak)]',
          ].join(' ')}
          key={tool.id}
          onClick={() => onSelect(tool)}
          type="button"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-[var(--tx)]">
              {tool.label}
            </span>
            {tool.source !== 'builtin' ? (
              <ToolBadge label={tool.source} source={tool.source} />
            ) : null}
            {tool.transport !== 'direct' ? (
              <ToolTransportPill transport={tool.transport} />
            ) : null}
            {tool.status !== 'active' ? (
              <ToolPermissionPill status={tool.status} />
            ) : null}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2 text-xs text-[color:var(--tx3)]">
            <code className="flex-shrink-0">{tool.toolId}</code>
            {tool.description ? (
              <span className="truncate">{tool.description}</span>
            ) : null}
          </div>
        </button>
      ))}
    </div>
  )
}
