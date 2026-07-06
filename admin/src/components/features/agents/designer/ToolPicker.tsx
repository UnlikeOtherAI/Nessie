import { useMemo, useState } from 'react'
import type { DesignerToolGroup, DesignerToolOption } from '../../../../facades/designer/tool-catalog'
import { isToolEnabled } from '../../../../facades/designer/tool-catalog'
import { Switch } from '../../../primitives/Switch'
import { EmptyState } from '../../../shared/EmptyState'

/**
 * Tool picker for the agent designer. Renders the real org tool catalog
 * (builtin + connector tools) as collapsible groups with per-tool switches.
 * `toolState` is the sparse policy overlay; unset tools fall back to the
 * kind's default (builtin on, connector off).
 */

type ToolPickerProps = {
  groups: DesignerToolGroup[]
  isLoading: boolean
  onToggle: (toolKey: string, enabled: boolean) => void
  toolState: Record<string, boolean>
}

const matchesQuery = (tool: DesignerToolOption, query: string): boolean =>
  tool.label.toLowerCase().includes(query) ||
  tool.key.toLowerCase().includes(query) ||
  tool.description.toLowerCase().includes(query)

type ToolGroupSectionProps = {
  group: DesignerToolGroup
  isFiltering: boolean
  onToggle: (toolKey: string, enabled: boolean) => void
  toolState: Record<string, boolean>
}

const ToolGroupSection = ({
  group,
  isFiltering,
  onToggle,
  toolState,
}: ToolGroupSectionProps) => {
  const [collapsed, setCollapsed] = useState(false)
  const enabledCount = group.tools.filter((tool) => isToolEnabled(tool, toolState)).length
  const expanded = isFiltering || !collapsed

  return (
    <div className="rounded-lg border border-[color:var(--sep)]">
      <button
        className={[
          'flex w-full items-center justify-between px-3 py-2.5',
          'text-left transition-colors hover:bg-[var(--overlay-weak)]',
        ].join(' ')}
        onClick={() => setCollapsed((prev) => !prev)}
        type="button"
      >
        <div className="flex items-center gap-2">
          <svg
            className={[
              'h-3.5 w-3.5 text-[color:var(--tx3)] transition-transform',
              expanded ? 'rotate-90' : '',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-sm font-medium text-[var(--tx)]">{group.name}</span>
        </div>
        <span className="text-xs text-[color:var(--tx3)]">
          {enabledCount}/{group.tools.length} enabled
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[color:var(--sep)] px-3 py-1.5">
          {group.tools.map((tool) => {
            const enabled = isToolEnabled(tool, toolState)
            return (
              <div
                className="flex items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-[var(--overlay-weak)]"
                key={tool.key}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--tx)]">{tool.label}</span>
                    <code className="text-[10px] text-[color:var(--tx3)]">{tool.key.length > 24 ? `${tool.key.slice(0, 8)}…` : tool.key}</code>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-[color:var(--tx3)]">
                    {tool.description}
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  label={`${enabled ? 'Disable' : 'Enable'} ${tool.label}`}
                  onChange={(next) => onToggle(tool.key, next)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const ToolPicker = ({ groups, isLoading, onToggle, toolState }: ToolPickerProps) => {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return groups
    return groups.flatMap((group) => {
      const tools = group.tools.filter((tool) => matchesQuery(tool, normalizedQuery))
      return tools.length > 0 ? [{ ...group, tools }] : []
    })
  }, [groups, normalizedQuery])

  if (isLoading) {
    return (
      <div className="py-4 text-center text-sm text-[color:var(--tx3)]">Loading tools…</div>
    )
  }

  if (groups.length === 0) {
    return <EmptyState>No tools are registered for this organisation yet.</EmptyState>
  }

  return (
    <div className="grid gap-2">
      <input
        autoComplete="off"
        className="admin-input"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search tools…"
        type="search"
        value={query}
      />
      {visibleGroups.length === 0 ? (
        <div className="py-4 text-center text-sm text-[color:var(--tx3)]">
          No tools match “{query.trim()}”.
        </div>
      ) : (
        visibleGroups.map((group) => (
          <ToolGroupSection
            group={group}
            isFiltering={normalizedQuery.length > 0}
            key={group.name}
            onToggle={onToggle}
            toolState={toolState}
          />
        ))
      )}
    </div>
  )
}
