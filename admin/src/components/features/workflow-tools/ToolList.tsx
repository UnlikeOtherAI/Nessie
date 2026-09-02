import { EmptyState } from '../../shared/EmptyState'
import { RowList } from '../../shared/RowList'
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
  /**
   * Set only when the caller is running a review pass. Reviewable rows then
   * grow a checkbox so a connector's tools can be approved as a batch — with
   * every name still on screen, so a destructive tool is unchecked
   * deliberately rather than swept in by a blanket "approve all".
   */
  onToggleSelected?: (toolId: string) => void
  selectedForReview?: ReadonlySet<string>
  isReviewable?: (tool: McpToolRegistryRecord) => boolean
  selectedId?: string
  tools: McpToolRegistryRecord[]
}

export const ToolList = ({
  isReviewable,
  onSelect,
  onToggleSelected,
  selectedForReview,
  selectedId,
  tools,
}: ToolListProps) => {
  if (tools.length === 0) {
    return <EmptyState>No tools match the current filter.</EmptyState>
  }

  return (
    // Not `Row`: a reviewable row carries a checkbox *and* a click target, and
    // `Row` renders one interactive element per row (a nested `<input>` inside
    // its own `<button>` would be invalid HTML and unreachable by keyboard).
    // `RowList` still gives the shared frame; the row markup stays custom.
    <RowList label="Tools">
      {tools.map((tool) => {
        const reviewable = Boolean(onToggleSelected && isReviewable?.(tool))
        return (
          <li
            className={[
              'flex items-start gap-2 border-l-2 pr-3 transition-colors',
              tool.id === selectedId
                ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
                : 'border-transparent hover:bg-[var(--overlay-weak)]',
            ].join(' ')}
            key={tool.id}
          >
            {reviewable ? (
              <label className="flex flex-shrink-0 items-center self-stretch pl-3">
                <input
                  aria-label={`Select ${tool.label} for review`}
                  checked={selectedForReview?.has(tool.id) ?? false}
                  className="h-4 w-4 accent-[var(--accent)]"
                  onChange={() => onToggleSelected?.(tool.id)}
                  type="checkbox"
                />
              </label>
            ) : null}
            <button
              className={[
                'min-w-0 flex-1 py-2.5 text-left',
                reviewable ? 'pl-1' : 'pl-3',
              ].join(' ')}
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
          </li>
        )
      })}
    </RowList>
  )
}
