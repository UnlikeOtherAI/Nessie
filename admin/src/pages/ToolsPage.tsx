import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ToolRegistryEntryStatus, ToolRegistrySource } from '@nessie/schemas'
import { OwnerGate } from '../components/shared/OwnerGate'
import { useIsOwner } from '../facades/auth/hooks'
import { Select } from '../components/shared/FormControls'
import { ListToolbar } from '../components/shared/ListToolbar'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { TabBar } from '../components/primitives/TabBar'
import { createListPageStore } from '../components/shared/list-page-state'
import { TOOL_SOURCE_SEGMENTS } from '../components/features/workflow-tools/ToolFilterBar'
import { ToolReviewBar } from '../components/features/workflow-tools/ToolReviewBar'
import { ToolsTable } from '../components/features/workflow-tools/ToolsTable'
import {
  matchesDeepWaterInstanceFilter,
  readDeepWaterInstanceFilter,
} from '../facades/tools/deep-water-tool-filter'
import {
  matchesMcpInstanceToolFilter,
  readMcpInstanceToolFilter,
} from '../facades/tools/mcp-instance-tool-filter'
import { useMcpToolRegistry } from '../facades/tool-grants/hooks'
import type { McpToolRegistryRecord } from '../facades/tool-grants/hooks'
import { useScrollMemory } from '../hooks/useScrollMemory'
import { useTabParam } from '../navigation/useTabParam'

const toolsListStore = createListPageStore()

const SOURCE_OPTIONS: Array<{ label: string; value: (typeof TOOL_SOURCE_SEGMENTS)[number] }> = [
  { label: 'All', value: 'all' },
  { label: 'Built-in', value: 'builtin' },
  { label: 'Custom', value: 'custom' },
  { label: 'MCP', value: 'mcp-remote' },
  { label: 'Session', value: 'interactive-session' },
]

// `?status=` is validated against these, so a hand-typed value degrades to Any
// rather than emptying the list. 'all' is this strip's name for no narrowing.
const STATUS_FILTERS = ['all', 'active', 'pending_review', 'disabled'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const STATUS_OPTIONS: Array<{ label: string; value: StatusFilter }> = [
  { label: 'Any status', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Pending review', value: 'pending_review' },
  { label: 'Disabled', value: 'disabled' },
]

/**
 * `/agents/tools` — the single, canonical tool surface.
 *
 * It was a column browser: a filtered rail beside the selected tool's detail.
 * It is now the section's ordinary shape — one header whose tabs are the source
 * strip, one table, one pager — and a tool is its own screen at
 * `/agents/tools/:toolId`.
 *
 * Reads the full tool registry (`/api/mcp/tools`, owner-only): builtin, MCP and
 * bundle tools with source, transport, tags and status.
 */
export const ToolsPage = () => {
  const navigate = useNavigate()
  // Still the page's own flag: the registry read below stays disabled for a
  // non-owner, exactly as it is behind `OwnerGate`'s refusal.
  const isOwner = useIsOwner()
  const [searchParams, setSearchParams] = useSearchParams()
  const deepWaterInstanceId = readDeepWaterInstanceFilter(searchParams)
  // `?instance=…&status=pending_review` narrows the owner review to tools from
  // one connection when setup identifies unreviewed tools.
  const instanceId = readMcpInstanceToolFilter(searchParams)

  // Source, status and the search phrase are all part of what the list shows,
  // so they live in the URL (docs/navigation/overview.md §1, "Tab hosts"):
  // `/agents/tools?source=mcp-remote&status=pending_review` is linkable and
  // survives a refresh.
  const [sourceSegment, setSourceSegment] = useTabParam('source', TOOL_SOURCE_SEGMENTS, 'all')
  const [statusFilter, setStatusFilter] = useTabParam('status', STATUS_FILTERS, 'all')
  const source: ToolRegistrySource | undefined =
    sourceSegment === 'all' ? undefined : sourceSegment
  const status: ToolRegistryEntryStatus | undefined =
    statusFilter === 'all' ? undefined : statusFilter

  const searchQuery = searchParams.get('search') ?? ''
  const setSearchQuery = useCallback((next: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current)
      if (next) params.set('search', next)
      else params.delete('search')
      return params
    }, { replace: true })
  }, [setSearchParams])

  const [tag, setTag] = useState<string | undefined>()
  const [selectedForReview, setSelectedForReview] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const toolsQuery = useMcpToolRegistry({ source, status }, isOwner)
  const allTools = useMemo(() => toolsQuery.data ?? [], [toolsQuery.data])

  const tagOptions = useMemo(() => {
    const set = new Set<string>()
    for (const tool of allTools) {
      for (const value of tool.tags) set.add(value)
    }
    return Array.from(set).sort()
  }, [allTools])

  const filteredTools = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return allTools
      .filter((tool) => {
        if (!matchesDeepWaterInstanceFilter(tool, deepWaterInstanceId)) return false
        if (!matchesMcpInstanceToolFilter(tool, instanceId)) return false
        if (tag && !tool.tags.includes(tag)) return false
        if (!query) return true
        return (
          tool.label.toLowerCase().includes(query)
          || tool.toolId.toLowerCase().includes(query)
          || tool.description.toLowerCase().includes(query)
        )
      })
      .sort((left, right) => left.label.localeCompare(right.label))
  }, [allTools, deepWaterInstanceId, instanceId, searchQuery, tag])

  /**
   * A row is reviewable when its status is something an owner can change here:
   * connector-projected tools that no first-party integration owns. Built-ins
   * have no review state, and DeepWater/DeepSignal projections are owned by
   * their product (the API refuses those ids).
   */
  const isReviewable = useCallback(
    (tool: McpToolRegistryRecord) =>
      !tool.builtin && tool.mcpInstanceId !== null && tool.managedProductSlug === null,
    [],
  )
  const reviewableShown = useMemo(
    () => filteredTools.filter(isReviewable),
    [filteredTools, isReviewable],
  )
  const selectedReviewIds = useMemo(
    () => reviewableShown.filter((tool) => selectedForReview.has(tool.id)).map((tool) => tool.id),
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

  const [initialState] = useState(toolsListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  const totalPages = Math.max(1, Math.ceil(filteredTools.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageTools = filteredTools.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = filteredTools.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, filteredTools.length)

  useEffect(() => {
    toolsListStore.save({ page, pageSize })
  }, [page, pageSize])

  const scroll = useScrollMemory('tools:list')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back — and the `h1` the settle focuses —
          never disappears with it
          (docs/navigation/deep-links-and-headers.md §9). Only the body below
          is owner-gated. */}
      <ScreenHeader
        eyebrow="Agents"
        subtitle={
          <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
            Every tool an agent can be given: the ones Nessie ships, the ones your connectors
            project, and the ones a paired session brings. Open one to audit its schema and
            decide which agents may call it.
          </p>
        }
        tabs={
          <TabBar
            ariaLabel="Filter by source"
            items={SOURCE_OPTIONS}
            onChange={(next) => {
              setSourceSegment(next)
              setRequestedPage(0)
            }}
            value={sourceSegment}
          />
        }
        title="Tools"
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        <OwnerGate>
          <div className="grid gap-3">
            <ListToolbar
              search={{
                label: 'Search tools',
                onChange: (value) => {
                  setSearchQuery(value)
                  setRequestedPage(0)
                },
                placeholder: 'Search by name, id or description…',
                value: searchQuery,
              }}
            >
              <Select
                aria-label="Filter by status"
                onChange={(event) => {
                  setStatusFilter(event.target.value as StatusFilter)
                  setRequestedPage(0)
                }}
                size="compact"
                value={statusFilter}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
              {tagOptions.length > 0 ? (
                <Select
                  aria-label="Filter by tag"
                  onChange={(event) => {
                    setTag(event.target.value || undefined)
                    setRequestedPage(0)
                  }}
                  size="compact"
                  value={tag ?? ''}
                >
                  <option value="">All tags</option>
                  {tagOptions.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
              ) : null}
            </ListToolbar>

            <ToolReviewBar
              onClearSelection={() => setSelectedForReview(new Set())}
              onSelectAllShown={() =>
                setSelectedForReview(new Set(reviewableShown.map((tool) => tool.id)))}
              reviewableCount={reviewableShown.length}
              selectedIds={selectedReviewIds}
            />

            <ToolsTable
              emptyMessage={
                allTools.length === 0
                  ? 'No tools are registered in this deployment yet.'
                  : 'No tools match the current filters.'
              }
              isLoading={toolsQuery.isPending}
              isReviewable={isReviewable}
              onOpen={(toolId) => void navigate(`/agents/tools/${toolId}`)}
              onToggleSelected={toggleSelected}
              selectedForReview={selectedForReview}
              tools={pageTools}
            />
          </div>
        </OwnerGate>
      </div>

      {/* Always visible: an empty or single-page list keeps its size control,
          and the table above it does not grow and shrink as pages change. */}
      <PaginationFooter
        canNext={page < totalPages - 1}
        canPrevious={page > 0}
        className="px-6 py-3"
        label={
          filteredTools.length === 0
            ? 'No tools'
            : `${rangeStart}–${rangeEnd} of ${filteredTools.length}`
        }
        onPageChange={setRequestedPage}
        onPageSizeChange={(next) => {
          setPageSize(next)
          setRequestedPage(0)
        }}
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
      />
    </div>
  )
}
