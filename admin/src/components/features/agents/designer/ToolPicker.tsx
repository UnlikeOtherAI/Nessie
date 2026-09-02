import { useMemo, useState } from 'react'
import type {
  DesignerToolCatalogQuery,
  DesignerToolGroup,
  DesignerToolOption,
} from '../../../../facades/designer/tool-catalog'
import { isToolEnabled } from '../../../../facades/designer/tool-catalog'
import { Switch } from '../../../primitives/Switch'
import { QueryState } from '../../../shared/QueryState'

/**
 * Tool picker for the agent designer. Renders the real org tool catalog
 * (builtin + connector tools) as collapsible groups with per-tool switches.
 * `toolState` is the sparse policy overlay; unset tools fall back to the
 * kind's default (builtin on, connector off).
 *
 * **Every group is closed at rest.** There are 116 builtins across sixteen
 * categories, so an open-by-default list buries the rest of the agent's
 * configuration under a page of switches nobody scrolled here to read. Closed,
 * the strip is an index: each row names its category and says how many of its
 * tools are on, which is the answer most visits need. Typing in the search box
 * opens every group that still has a match, so finding one tool never costs a
 * click through a section heading.
 */

type ToolPickerProps = {
  groups: DesignerToolGroup[]
  onToggle: (toolKey: string, enabled: boolean) => void
  query: DesignerToolCatalogQuery
  /**
   * Show the switches, disabled. A viewer who cannot change a tool sees the
   * *same page* as one who can — same sections, same rows, same control in the
   * same place — with the control visibly not theirs to press. The read-only
   * view used to be a second component with its own grouping, its own cards,
   * status chips instead of switches and no search at all, so it read as a
   * different screen about a different thing.
   */
  readOnly?: boolean
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
  readOnly: boolean
  toolState: Record<string, boolean>
}

const ToolGroupSection = ({
  group,
  isFiltering,
  onToggle,
  readOnly,
  toolState,
}: ToolGroupSectionProps) => {
  const [open, setOpen] = useState(false)
  const enabledCount = group.tools.filter((tool) => isToolEnabled(tool, toolState)).length
  // A search result is not a section a person opened, so it expands without
  // touching the group's own state: clearing the box returns the list to
  // exactly the sections they had opened themselves.
  const expanded = isFiltering || open

  return (
    <div className="rounded-lg border border-[color:var(--sep)]">
      <button
        className={[
          'flex w-full items-center justify-between px-3 py-2.5',
          'text-left transition-colors hover:bg-[var(--overlay-weak)]',
        ].join(' ')}
        aria-expanded={expanded}
        onClick={() => setOpen((previous) => !previous)}
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
          <span className="min-w-0">
            <span className="block text-sm font-medium text-[var(--tx)]">{group.name}</span>
            {group.description ? (
              <span className="mt-0.5 block text-xs text-[color:var(--tx3)]">
                {group.description}
              </span>
            ) : null}
          </span>
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
                id={`agent-tool-${tool.key}`}
                key={tool.key}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--tx)]">{tool.label}</span>
                    {tool.kind === 'builtin' ? (
                      <code className="text-[10px] text-[color:var(--tx3)]">{tool.key}</code>
                    ) : null}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-[color:var(--tx3)]">
                    {tool.description}
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  disabled={readOnly}
                  label={
                    readOnly
                      ? `${tool.label} is ${enabled ? 'enabled' : 'off'}`
                      : `${enabled ? 'Disable' : 'Enable'} ${tool.label}`
                  }
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

export const ToolPicker = ({
  groups,
  onToggle,
  query,
  readOnly = false,
  toolState,
}: ToolPickerProps) => {
  const [search, setSearch] = useState('')
  const normalizedQuery = search.trim().toLowerCase()

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return groups
    return groups.flatMap((group) => {
      const tools = group.tools.filter((tool) => matchesQuery(tool, normalizedQuery))
      return tools.length > 0 ? [{ ...group, tools }] : []
    })
  }, [groups, normalizedQuery])

  return (
    <QueryState
      className="py-4"
      emptyLabel="No tools are registered for this organisation yet."
      errorLabel="Tools could not be loaded."
      isEmpty={groups.length === 0}
      loadingLabel="Loading tools…"
      query={query}
    >
      {() => (
        <div className="grid gap-2">
          <input
            autoComplete="off"
            className="admin-input"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tools…"
            type="search"
            value={search}
          />
          {visibleGroups.length === 0 ? (
            <div className="py-4 text-center text-sm text-[color:var(--tx3)]">
              No tools match “{search.trim()}”.
            </div>
          ) : (
            visibleGroups.map((group) => (
              <ToolGroupSection
                group={group}
                isFiltering={normalizedQuery.length > 0}
                key={group.name}
                onToggle={onToggle}
                readOnly={readOnly}
                toolState={toolState}
              />
            ))
          )}
        </div>
      )}
    </QueryState>
  )
}
