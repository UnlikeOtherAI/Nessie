import { useMemo, useState } from 'react'
import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { ToolAgentAccessPanel } from '../components/features/workflow-tools/ToolAgentAccessPanel'
import { ToolDetailDrawer } from '../components/features/workflow-tools/ToolDetailDrawer'
import { ToolFilterBar } from '../components/features/workflow-tools/ToolFilterBar'
import { ToolList } from '../components/features/workflow-tools/ToolList'
import { useAgents } from '../facades/agents/hooks'
import { useMcpToolRegistry } from '../facades/tool-grants/hooks'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useAuthSession } from '../providers/AuthSessionProvider'

/**
 * `/agents/tools` — the single, canonical tool surface.
 *
 * Two-pane column-browser layout:
 *   [search + filters + tool list] → [tool detail + per-agent access]
 *
 * Reads the full tool registry (`/api/mcp/tools`, owner-only): builtin, MCP,
 * and bundle tools with source/transport/tags/status, managing per-agent
 * grants inline.
 */
export const ToolsPage = () => {
  const { me } = useAuthSession()
  const isMobile = useMediaQuery('(max-width: 767px)')
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  const [source, setSource] = useState<ToolRegistrySource | undefined>()
  const [status, setStatus] = useState<ToolRegistryEntryStatus | undefined>()
  const [tag, setTag] = useState<string | undefined>()
  const [searchQuery, setSearchQuery] = useState('')
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

  const filteredTools = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return allTools.filter((tool) => {
      if (tag && !tool.tags.includes(tag)) return false
      if (!query) return true
      return (
        tool.label.toLowerCase().includes(query) ||
        tool.toolId.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query)
      )
    })
  }, [allTools, searchQuery, tag])

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
    <ColumnBrowserColumn key="list" title={`Tools (${sortedTools.length})`}>
      <div className="grid gap-3">
        <input
          autoComplete="off"
          className="admin-input"
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search by name, id or description…"
          type="search"
          value={searchQuery}
        />
        <ToolFilterBar
          onSourceChange={setSource}
          onStatusChange={setStatus}
          onTagChange={setTag}
          source={source}
          status={status}
          tag={tag}
          tagOptions={tagOptions}
        />
        {listBody}
      </div>
    </ColumnBrowserColumn>,
  ]

  if (selectedTool) {
    columns.push(
      <ColumnBrowserColumn
        key={`detail-${selectedTool.id}`}
        onBack={() => setSelectedToolId(undefined)}
        showBack={isMobile}
        title={selectedTool.label}
      >
        <div className="grid gap-6">
          <ToolDetailDrawer tool={selectedTool} />
          <section>
            <h3 className="text-sm font-semibold text-[color:var(--tx)]">Agent access</h3>
            <p className="mt-1 text-xs text-[color:var(--tx3)]">
              Switch a row on to grant this tool to that agent; switch it off to
              revoke. A denied grant is read-only and always wins.
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
                <ToolAgentAccessPanel agents={agentsQuery.data ?? []} tool={selectedTool} />
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
        activeColumn={selectedToolId && selectedTool ? 1 : 0}
        columns={columns}
      />
    </div>
  )
}
