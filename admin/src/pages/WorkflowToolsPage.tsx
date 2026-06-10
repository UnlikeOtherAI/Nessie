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

/**
 * `/workflows/tools` — inside the Workflows section per plan §7 surface 2.
 *
 * Three-pane column-browser layout:
 *   [filters] → [tool list] → [tool detail + agent grant matrix]
 *
 * Reuses the four mandated tool primitives (`ToolBadge`,
 * `ToolTransportPill`, `ToolPermissionPill`, `ToolCategoryIcon`) via
 * `ToolList` and `ToolDetailDrawer`.
 */

export const WorkflowToolsPage = () => {
  const [source, setSource] = useState<ToolRegistrySource | undefined>()
  const [status, setStatus] = useState<ToolRegistryEntryStatus | undefined>()
  const [tag, setTag] = useState<string | undefined>()
  const [selectedToolId, setSelectedToolId] = useState<string | undefined>()

  const toolsQuery = useMcpToolRegistry({ source, status })
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
      <ToolList
        onSelect={(tool) => setSelectedToolId(tool.id)}
        selectedId={selectedTool?.id}
        tools={sortedTools}
      />
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
              Tick a cell to grant the tool to that agent. The grant is created
              as `allowed`; removing access uses the dedicated DELETE endpoint
              (per-tool drawer in a follow-up).
            </p>
            <div className="mt-3">
              <AgentGrantMatrix
                agents={agentsQuery.data ?? []}
                tools={[selectedTool]}
              />
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
