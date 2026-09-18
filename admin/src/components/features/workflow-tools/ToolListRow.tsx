import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { McpToolRegistryRecord } from '../../../facades/tool-grants/hooks'
import { ToolBadge } from '../../shared/ToolBadge'
import { ToolPermissionPill } from '../../shared/ToolPermissionPill'
import { ToolTransportPill } from '../../shared/ToolTransportPill'

type ToolListRowProps = {
  onOpen: (toolId: string) => void
  /**
   * Set only while a review pass is running. A reviewable row then carries a
   * checkbox so one connector's tools can be approved as a batch — with every
   * name still on screen, so a destructive tool is unchecked deliberately
   * rather than swept in by a blanket "approve all".
   */
  onToggleSelected?: (toolId: string) => void
  reviewable: boolean
  selectedForReview: boolean
  tool: McpToolRegistryRecord
}

// One tool row. Badges are exception-based: a built-in, direct-transport,
// active tool — the overwhelming default — renders none at all, so a badge
// appearing means the tool deviates and deserves attention. The whole row
// opens tool detail, which owns the full metadata and per-agent access.
export const ToolListRow = ({
  onOpen,
  onToggleSelected,
  reviewable,
  selectedForReview,
  tool,
}: ToolListRowProps) => (
  <tr
    className="cursor-pointer"
    onClick={() => onOpen(tool.id)}
    tabIndex={0}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen(tool.id)
      }
    }}
  >
    <td className="w-9 py-2.5 pl-4 pr-0 align-middle">
      {reviewable && onToggleSelected ? (
        <input
          aria-label={`Select ${tool.label} for review`}
          checked={selectedForReview}
          className="h-4 w-4 accent-[var(--accent)]"
          onChange={() => onToggleSelected(tool.id)}
          // The row opens the tool; ticking it for review must not do both.
          onClick={(event) => event.stopPropagation()}
          type="checkbox"
        />
      ) : null}
    </td>
    <td className="min-w-0 px-3 py-2.5 align-middle">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-[color:var(--tx)]">
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
      <div className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs text-[color:var(--tx3)]">
        <code className="flex-shrink-0">{tool.toolId}</code>
        {tool.description ? (
          <span className="min-w-0 flex-1 truncate">{tool.description}</span>
        ) : null}
      </div>
    </td>
    <td className="hidden w-32 px-3 py-2.5 align-middle text-xs text-[color:var(--tx2)] md:table-cell">
      {tool.source}
    </td>
    <td className="hidden w-40 px-3 py-2.5 align-middle text-xs text-[color:var(--tx3)] lg:table-cell">
      {tool.tags.join(', ') || '—'}
    </td>
    <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
      <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={faChevronRight} />
    </td>
  </tr>
)
