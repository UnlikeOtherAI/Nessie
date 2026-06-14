import { useMemo, useState } from 'react'
import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { AgentGrantMatrix } from '../components/features/workflow-tools/AgentGrantMatrix'
import { ToolDetailDrawer } from '../components/features/workflow-tools/ToolDetailDrawer'
import { ToolFilterBar } from '../components/features/workflow-tools/ToolFilterBar'
import { ToolList } from '../components/features/workflow-tools/ToolList'
import { useAgents } from '../facades/agents/hooks'
import { useMcpToolRegistry } from '../facades/tool-grants/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

/**
 * `/agents/tools` — the single, canonical tool surface.
 *
 * Three-pane column-browser layout:
 *   [filters] → [tool list] → [tool detail + per-agent grant matrix]
 *
 * Reads the full tool registry (`/api/mcp/tools`, owner-only) which is a
 * superset of the legacy builtin-only descriptor feed: it carries builtin,
 * MCP, and bundle tools with source/transport/tags/status, and manages
 * per-agent grants inline. This absorbs the former read-only `/settings/tools`
 * and the orphaned `/workflows/tools`.
 */
export const ToolsPage = () => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  const [source, setSource] = useState<ToolRegistrySource | undefined>()
  const [status, setStatus] = useState<ToolRegistryEntryStatus | undefined>()
  const [tag, setTag] = useState<string | undefined>()
  const [selectedToolId, setSelectedToolId] = useState<string | undefined>()

  const toolsQuery = useMcpToolRegistry({ source, status }, isOwner)
  const agentsQuery = useAgents()

  const allTools = useMemo(() => toolsQuery.data ?? [], [toolsQuery.data])
  const tagOptions = useMemo(() => {
    const set = new Set<string>()
    for (const tool of allTools) {
      for (const value of tool.tags) {
        set.add(value)
      }
    }
    return Array.from(set).sort()
  }, [allTools])

  const filteredTools = useMemo(
    () => (tag ? allTools.filter((tool) => tool.tags.includes(tag)) : allTools),
    [allTools, tag],
  )

  const sortedTools = useMemo(
    () =>
      [...filteredTools].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [filteredTools],
  )

  const selectedTool = useMemo(
    () =>
      sortedTools.find((tool) => tool.id === selectedToolId)
      ?? sortedTools[0],
    [sortedTools, selectedToolId],
  )

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  const listBody = toolsQuery.isLoading ? (
    <div className="py-8 text-center text-sm text-[color:var(--tx3)]">Loading tools…</div>
  ) : toolsQuery.isError ? (
    <div className="py-8 text-center text-sm text-[color:var(--danger-text)]">
      Failed to load tools.{' '}
      <button className="underline" onClick={() => void toolsQuery.refetch()} type="button">
        Retry
      </button>
    </div>
  ) : (
    <ToolList
      onSelect={(tool) => setSelectedToolId(tool.id)}
      selectedId={selectedTool?.id}
      tools={sortedTools}
    />
  )

  const columns = [
    <ColumnBrowserColumn key="filters" title="Filters">
      <ToolFilterBar
        onSourceChange={setSource}
        onStatusChange={setStatus}
        onTagChange={setTag}
        source={source}
        status={status}
        tag={tag}
        tagOptions={tagOptions}
      />
    </ColumnBrowserColumn>,
    <ColumnBrowserColumn key="list" title={`Tools (${sortedTools.length})`}>
      {listBody}
    </ColumnBrowserColumn>,
  ]

  if (selectedTool) {
    columns.push(
      <ColumnBrowserColumn key={`detail-${selectedTool.id}`} title={selectedTool.label}>
        <div className="grid gap-6">
          <ToolDetailDrawer tool={selectedTool} />
          <section>
            <h3 className="text-sm font-semibold text-[color:var(--tx)]">Per-agent grants</h3>
            <p className="mt-1 text-xs text-[color:var(--tx3)]">
              Tick a cell to grant this tool to an agent; untick to revoke. A
              denied grant is shown as read-only and takes precedence.
            </p>
            <div className="mt-3">
              {agentsQuery.isLoading ? (
                <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
                  Loading agents…
                </div>
              ) : agentsQuery.isError ? (
                <div className="py-6 text-center text-sm text-[color:var(--danger-text)]">
                  Failed to load agents.{' '}
                  <button
                    className="underline"
                    onClick={() => void agentsQuery.refetch()}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <AgentGrantMatrix agents={agentsQuery.data ?? []} tools={[selectedTool]} />
              )}
            </div>
          </section>
        </div>
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={selectedTool ? 2 : 1}
        columns={columns}
      />
    </div>
  )
}
