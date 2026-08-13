import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  ToolRegistryEntryStatus,
  ToolRegistrySource,
} from '@nessie/schemas'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { ToolAgentAccessPanel } from '../components/features/workflow-tools/ToolAgentAccessPanel'
import { ExplicitToolAgentAccessPanel } from '../components/features/workflow-tools/ExplicitToolAgentAccessPanel'
import { ToolDetailDrawer } from '../components/features/workflow-tools/ToolDetailDrawer'
import { ToolFilterBar } from '../components/features/workflow-tools/ToolFilterBar'
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
import { usePhoneLayout } from '../lib/mobile-shell'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'

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
  const isMobile = usePhoneLayout()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const [searchParams] = useSearchParams()
  const deepWaterInstanceId = readDeepWaterInstanceFilter(searchParams)
  // The Connectors page links here with `?instance=…&status=pending_review`
  // when an install has tools nobody has reviewed yet.
  const instanceId = readMcpInstanceToolFilter(searchParams)

  const [source, setSource] = useState<ToolRegistrySource | undefined>()
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
      isReviewable={isReviewable}
      onSelect={(tool) => setSelectedToolId(tool.id)}
      onToggleSelected={toggleSelected}
      selectedForReview={selectedForReview}
      selectedId={selectedTool?.id}
      tools={sortedTools}
    />
  )

  const columns = [
    <ColumnBrowserColumn leading={<PhoneNavigationButton />} key="list" title={`Tools (${sortedTools.length})`}>
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
        <div className="grid max-w-3xl gap-6">
          <ToolDetailDrawer tool={selectedTool} />
          <ToolReviewActions tool={selectedTool} />
          <section>
            <h3 className="text-sm font-semibold text-[color:var(--tx)]">Agent access</h3>
            <p className="mt-1 text-xs text-[color:var(--tx3)]">
              {selectedTool.requiresExplicitGrant
                ? 'This tool is off by default. Switch a row on to write the exact per-agent allow; switch it off to revoke only that allow.'
                : 'Switch a row on to grant this tool to that agent; switch it off to revoke. A denied grant is read-only and always wins.'}
            </p>
            <div className="mt-3">
              {(selectedTool.requiresExplicitGrant
                ? policyTargetsQuery.isLoading
                : agentsQuery.isLoading) ? (
                <div className="py-6 text-center text-sm text-[color:var(--tx3)]">
                  Loading agents…
                </div>
              ) : (selectedTool.requiresExplicitGrant
                ? policyTargetsQuery.isError
                : agentsQuery.isError) ? (
                <div className="py-6 text-center text-sm text-[color:var(--danger-text)]">
                  Failed to load agents.{' '}
                  <button
                    className="underline"
                    onClick={() => {
                      if (selectedTool.requiresExplicitGrant) {
                        void policyTargetsQuery.refetch()
                      } else {
                        void agentsQuery.refetch()
                      }
                    }}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              ) : selectedTool.requiresExplicitGrant ? (
                <ExplicitToolAgentAccessPanel
                  deepWaterDependencyPolicyKeys={deepWaterDependencyPolicyKeys}
                  targets={policyTargetsQuery.data ?? []}
                  tool={selectedTool}
                />
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
