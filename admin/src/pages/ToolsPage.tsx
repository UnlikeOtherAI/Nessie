import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { OwnerGate, useIsOwner } from '../components/shared/OwnerGate'
import { QueryState } from '../components/shared/QueryState'
import { ToolAgentAccessPanel } from '../components/features/workflow-tools/ToolAgentAccessPanel'
import { ExplicitToolAgentAccessPanel } from '../components/features/workflow-tools/ExplicitToolAgentAccessPanel'
import { ToolDetailDrawer } from '../components/features/workflow-tools/ToolDetailDrawer'
import {
  ToolFilterBar,
  TOOL_SOURCE_SEGMENTS,
} from '../components/features/workflow-tools/ToolFilterBar'
import { ToolList } from '../components/features/workflow-tools/ToolList'
import { ToolReviewActions } from '../components/features/workflow-tools/ToolReviewActions'
import { ToolReviewBar } from '../components/features/workflow-tools/ToolReviewBar'
import { useAgents } from '../facades/agents/hooks'
import {
  matchesDeepWaterInstanceFilter,
  readDeepWaterInstanceFilter,
} from '../facades/deep-water-tool-filter'
import {
  matchesMcpInstanceToolFilter,
  readMcpInstanceToolFilter,
} from '../facades/mcp-instance-tool-filter'
import {
  useAgentToolPolicyTargets,
  useMcpToolRegistry,
} from '../facades/tool-grants/hooks'
import type { McpToolRegistryRecord } from '../facades/tool-grants/hooks'
import { useTabParam } from '../navigation/useTabParam'
import { usePhoneLayout } from '../lib/mobile-shell'

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
  const phoneLayout = usePhoneLayout()
  // Still the page's own flag: the registry and policy-target reads below stay
  // disabled for a non-owner, exactly as before OwnerGate wrapped the render.
  const isOwner = useIsOwner()
  const [searchParams] = useSearchParams()
  const deepWaterInstanceId = readDeepWaterInstanceFilter(searchParams)
  // `?instance=…&status=pending_review` narrows the owner review to tools from
  // one connection when setup identifies unreviewed tools.
  const instanceId = readMcpInstanceToolFilter(searchParams)

  // The source narrowing is part of what the list shows, so it lives in the
  // URL alongside `?status=` and `?search=` (docs/navigation/overview.md §1,
  // "Tab hosts"). 'all' is the strip's name for no narrowing at all.
  const [sourceSegment, setSourceSegment] = useTabParam(
    'source',
    TOOL_SOURCE_SEGMENTS,
    'all',
  )
  const source: ToolRegistrySource | undefined =
    sourceSegment === 'all' ? undefined : sourceSegment
  const [status, setStatus] = useState<ToolRegistryEntryStatus | undefined>(
    () => {
      const initial = searchParams.get('status')
      return initial === 'pending_review' || initial === 'active'
        || initial === 'disabled'
        ? initial
        : undefined
    },
  )
  const [tag, setTag] = useState<string | undefined>()
  const [searchQuery, setSearchQuery] = useState(
    () => searchParams.get('search') ?? '',
  )
  const [selectedToolId, setSelectedToolId] = useState<string | undefined>()
  const [selectedForReview, setSelectedForReview] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const toolsQuery = useMcpToolRegistry({ source, status }, isOwner)
  const agentsQuery = useAgents()
  const policyTargetsQuery = useAgentToolPolicyTargets(isOwner)

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
      if (!matchesDeepWaterInstanceFilter(tool, deepWaterInstanceId)) {
        return false
      }
      if (!matchesMcpInstanceToolFilter(tool, instanceId)) return false
      if (tag && !tool.tags.includes(tag)) return false
      if (!query) return true
      return (
        tool.label.toLowerCase().includes(query) ||
        tool.toolId.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query)
      )
    })
  }, [allTools, deepWaterInstanceId, instanceId, searchQuery, tag])

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
  const deepWaterDependencyPolicyKeys = useMemo(
    () =>
      allTools
        .filter(
          (tool) =>
            tool.managedProductSlug === 'deep-water'
            && tool.mcpInstanceId !== null,
        )
        .map((tool) => tool.policyKey),
    [allTools],
  )

  /**
   * A row is reviewable when its status is something an owner can change here:
   * connector-projected tools that no first-party integration owns. Built-ins
   * have no review state, and DeepWater/DeepSignal projections are managed
   * from Integrations (the API refuses those ids).
   */
  const isReviewable = useCallback(
    (tool: McpToolRegistryRecord) =>
      !tool.builtin
      && tool.mcpInstanceId !== null
      && tool.managedProductSlug === null,
    [],
  )
  const reviewableShown = useMemo(
    () => sortedTools.filter(isReviewable),
    [isReviewable, sortedTools],
  )
  const selectedReviewIds = useMemo(
    () =>
      reviewableShown
        .filter((tool) => selectedForReview.has(tool.id))
        .map((tool) => tool.id),
    [reviewableShown, selectedForReview],
  )
  const toggleSelected = useCallback((toolId: string) => {
    setSelectedForReview((current) => {
      const next = new Set(current)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })
  }, [])

  // No `emptyLabel`: ToolList already distinguishes "no tools at all" from
  // "none match the current filter", which this component could not.
  const listBody = (
    <QueryState
      errorLabel="Failed to load tools."
      loadingLabel="Loading tools…"
      query={toolsQuery}
    >
      {() => (
        <ToolList
          isReviewable={isReviewable}
          onSelect={(tool) => setSelectedToolId(tool.id)}
          onToggleSelected={toggleSelected}
          selectedForReview={selectedForReview}
          selectedId={selectedTool?.id}
          tools={sortedTools}
        />
      )}
    </QueryState>
  )

  const columns = [
    // The header is always rendered: a refusal is a state of this screen, not
    // a screen of its own, so Back — and the h1 the settle focuses — never
    // disappears with it (docs/navigation/deep-links-and-headers.md §9). Only
    // the body underneath is owner-gated.
    <ColumnBrowserColumn key="list" screen title={`Tools (${sortedTools.length})`}>
      <OwnerGate>
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
            onSourceChange={setSourceSegment}
            onStatusChange={setStatus}
            onTagChange={setTag}
            source={sourceSegment}
            status={status}
            tag={tag}
            tagOptions={tagOptions}
          />
          <ToolReviewBar
            onClearSelection={() => setSelectedForReview(new Set())}
            onSelectAllShown={() =>
              setSelectedForReview(new Set(reviewableShown.map((tool) => tool.id)))
            }
            reviewableCount={reviewableShown.length}
            selectedIds={selectedReviewIds}
          />
          {listBody}
        </div>
      </OwnerGate>
    </ColumnBrowserColumn>,
  ]

  if (selectedTool) {
    columns.push(
      <ColumnBrowserColumn
        key={`detail-${selectedTool.id}`}
        onBack={() => setSelectedToolId(undefined)}
        showBack
        title={selectedTool.label}
      >
        <div className="grid gap-6">
          <ToolDetailDrawer tool={selectedTool} />
          <ToolReviewActions tool={selectedTool} />
          <section>
            <h3 className="text-sm font-semibold text-[color:var(--tx)]">Agent access</h3>
            <p className="mt-1 text-xs text-[color:var(--tx3)]">
              {selectedTool.requiresExplicitGrant
                ? 'This tool is off by default. Switch a row on to write the exact per-agent allow; switch it off to revoke only that allow.'
                : 'Switch a row on to grant this tool to that agent; switch it off to revoke. A denied grant is read-only and always wins.'}
            </p>
            {/* `py-6`, not the default `py-8`: these states swap with the two
                access panels, whose own "no agents yet" line is py-6. */}
            <div className="mt-3">
              <QueryState
                className="py-6"
                errorLabel="Failed to load agents."
                loadingLabel="Loading agents…"
                query={
                  selectedTool.requiresExplicitGrant ? policyTargetsQuery : agentsQuery
                }
              >
                {() =>
                  selectedTool.requiresExplicitGrant ? (
                    <ExplicitToolAgentAccessPanel
                      deepWaterDependencyPolicyKeys={deepWaterDependencyPolicyKeys}
                      targets={policyTargetsQuery.data ?? []}
                      tool={selectedTool}
                    />
                  ) : (
                    <ToolAgentAccessPanel agents={agentsQuery.data ?? []} tool={selectedTool} />
                  )
                }
              </QueryState>
            </div>
          </section>
        </div>
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={phoneLayout && selectedToolId && selectedTool ? 1 : 0}
        columns={columns}
      />
    </div>
  )
}
