import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AgentChild } from '@nessie/schemas'
import { useAgentCategories } from '../../../facades/agent-categories/hooks'
import { useAgentChildren, useAgents } from '../../../facades/agents/hooks'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import type {
  AgentCategoryRecord,
  AgentRecord,
} from '../../../lib/api-client'
import { AgentColumn } from './AgentColumn'
import { AgentCreateButton } from './AgentCreateButton'
import { AgentColumnItem } from './AgentColumnItem'
import { AgentDetailColumn } from './AgentDetailColumn'
import { AgentStatusDot } from './AgentStatusDot'
import { CategoryAgentsPopup } from './CategoryAgentsPopup'
import { CreateCategoryDialog } from './CreateCategoryDialog'
import { SubAgentPopup } from './SubAgentPopup'

// ─── Static category definitions ───────────────────────────────────────────

type StaticCategoryId = 'all' | 'global' | 'personal' | 'system'

type CategorySelection =
  | { kind: 'custom'; id: string }
  | { kind: 'static'; id: StaticCategoryId }

const STATIC_CATEGORIES: Array<{
  description: string
  id: StaticCategoryId
  name: string
}> = [
  { id: 'all', name: 'All', description: 'Every agent in the workspace' },
  {
    id: 'system',
    name: 'System',
    description: 'Built-in orchestrator agents',
  },
  {
    id: 'global',
    name: 'Global',
    description: 'Agents available to all channels',
  },
  {
    id: 'personal',
    name: 'Personal',
    description: 'Agents you created',
  },
]

// ─── Children helpers (unchanged) ──────────────────────────────────────────

type AgentChildrenListProps = {
  onSelect: (child: AgentChild) => void
  parentId: string
  selectedId?: string
}

const AgentChildrenList = ({
  onSelect,
  parentId,
  selectedId,
}: AgentChildrenListProps) => {
  const { data: children = [] } = useAgentChildren(parentId)

  if (children.length === 0) {
    return (
      <div
        className="px-3 py-6 text-center text-xs text-[color:var(--tx3)]"
      >
        No child agents
      </div>
    )
  }

  return (
    <>
      {children.map((child) => (
        <AgentColumnItem
          agent={child}
          isSelected={child.agentId === selectedId}
          key={child.agentId}
          onClick={() => onSelect(child)}
        />
      ))}
    </>
  )
}

const agentGradient = 'linear-gradient(135deg,#7c3aed,#6d28d9)'

const getAgentGlyph = (status: AgentChild['status']): string => {
  if (status === 'executing' || status === 'thinking') return '\u26A1'
  if (status === 'error') return '\u26A0'
  return '\u{1F916}'
}

type AgentChildrenHeaderProps = {
  onOpenPopup: () => void
  parentAgent: AgentRecord
  parentId: string
}

const AgentChildrenHeader = ({
  onOpenPopup,
  parentAgent,
  parentId,
}: AgentChildrenHeaderProps) => {
  const { data: children = [] } = useAgentChildren(parentId)
  const displayedChildren = children.slice(0, 5)

  return (
    <div
      className={[
        'mb-2 rounded-lg border border-[color:var(--sep)]',
        'bg-[color:var(--panel)] p-3',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AgentStatusDot status={parentAgent.status} />
          <div>
            <div className="text-sm font-medium text-white">
              {parentAgent.name}
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              {parentAgent.role}
            </div>
          </div>
        </div>
        <button
          className={[
            'flex items-center gap-0.5 rounded-full px-1 py-0.5',
            'transition-colors hover:bg-white/10',
          ].join(' ')}
          onClick={onOpenPopup}
          title="Manage sub-agents"
          type="button"
        >
          <div className="flex items-center -space-x-1.5">
            {displayedChildren.map((child) => (
              <div
                className={[
                  'flex h-[22px] w-[22px] items-center justify-center',
                  'rounded-full border-2 border-[color:var(--panel)]',
                  'text-[10px]',
                ].join(' ')}
                key={child.agentId}
                style={{ background: agentGradient }}
                title={child.name}
              >
                {getAgentGlyph(child.status)}
              </div>
            ))}
          </div>
          <div
            className={[
              'flex h-[22px] w-[22px] items-center justify-center',
              'rounded-full border-2 border-[color:var(--panel)]',
              'bg-white/10 text-xs text-[color:var(--tx3)]',
            ].join(' ')}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path
                d="M12 5v14M5 12h14"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </button>
      </div>
    </div>
  )
}

// ─── Category column item ──────────────────────────────────────────────────

type CategoryItemProps = {
  description: string
  isSelected: boolean
  name: string
  onClick: () => void
}

const CategoryItem = ({
  description,
  isSelected,
  name,
  onClick,
}: CategoryItemProps) => (
  <button
    className={[
      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5',
      'text-left transition-colors',
      isSelected
        ? 'bg-[color:var(--accent)] text-white'
        : 'text-[color:var(--tx)] hover:bg-white/8',
    ].join(' ')}
    onClick={onClick}
    type="button"
  >
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">{name}</div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {description}
      </div>
    </div>
    <svg
      className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="M9 5l7 7-7 7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>
)

// ─── Category column content ──────────────────────────────────────────────

type CategoryColumnContentProps = {
  categories: AgentCategoryRecord[]
  onCreateClick: () => void
  onSelect: (selection: CategorySelection) => void
  selected: CategorySelection | null
}

const CategoryColumnContent = ({
  categories,
  onCreateClick,
  onSelect,
  selected,
}: CategoryColumnContentProps) => {
  const isSelected = (sel: CategorySelection): boolean => {
    if (!selected) return false
    if (selected.kind !== sel.kind) return false
    return selected.id === sel.id
  }

  return (
    <>
      {/* Static categories */}
      {STATIC_CATEGORIES.map((cat) => (
        <CategoryItem
          description={cat.description}
          isSelected={isSelected({ kind: 'static', id: cat.id })}
          key={cat.id}
          name={cat.name}
          onClick={() => onSelect({ kind: 'static', id: cat.id })}
        />
      ))}

      {/* Divider if we have custom categories */}
      {categories.length > 0 && (
        <div className="mx-2 my-2 border-t border-[color:var(--sep)]" />
      )}

      {/* Custom categories */}
      {categories.map((cat) => (
        <CategoryItem
          description={
            cat.description
              ?? `${cat.agentIds.length} agent${cat.agentIds.length !== 1 ? 's' : ''} \u00B7 ${cat.visibility}`
          }
          isSelected={isSelected({ kind: 'custom', id: cat.id })}
          key={cat.id}
          name={cat.name}
          onClick={() => onSelect({ kind: 'custom', id: cat.id })}
        />
      ))}

      {/* New category button */}
      <div className="mx-2 mt-2 border-t border-[color:var(--sep)] pt-2">
        <button
          className={[
            'flex w-full items-center gap-2 rounded-lg',
            'px-3 py-2 text-left text-xs',
            'text-[color:var(--tx3)]',
            'transition-colors hover:bg-white/5',
            'hover:text-[color:var(--tx2)]',
          ].join(' ')}
          onClick={onCreateClick}
          type="button"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              d="M12 5v14M5 12h14"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          New category
        </button>
      </div>
    </>
  )
}

// ─── Main browser ──────────────────────────────────────────────────────────

export const AgentColumnBrowser = () => {
  const navigate = useNavigate()
  const { data: agents = [] } = useAgents()
  const { data: customCategories = [] } = useAgentCategories()

  const [selectedCategory, setSelectedCategory] =
    useState<CategorySelection | null>(null)
  const [selectionPath, setSelectionPath] = useState<string[]>([])
  const [activeColumn, setActiveColumn] = useState(0)
  const [subAgentPopupAgentId, setSubAgentPopupAgentId] = useState<
    string | null
  >(null)
  const [categoryPopupId, setCategoryPopupId] = useState<string | null>(
    null,
  )
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false)

  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery(
    '(min-width: 768px) and (max-width: 1023px)',
  )

  const visibleColumns = isMobile ? 1 : isTablet ? 2 : 3

  const rootAgents = useMemo(
    () => agents.filter((a) => !a.parentAgentId),
    [agents],
  )

  const allAgentsById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  )

  // Filter agents based on selected category
  const filteredAgents = useMemo(() => {
    if (!selectedCategory) return rootAgents

    if (selectedCategory.kind === 'static') {
      switch (selectedCategory.id) {
        case 'all':
          return rootAgents
        case 'system':
          return rootAgents.filter(
            (a) =>
              a.role === 'orchestrator' ||
              a.role === 'system' ||
              a.name.toLowerCase().includes('system'),
          )
        case 'global':
          return rootAgents.filter(
            (a) => a.channelIds.length > 1 || a.channelIds.length === 0,
          )
        case 'personal':
          return rootAgents
        default:
          return rootAgents
      }
    }

    const customCat = customCategories.find(
      (c) => c.id === selectedCategory.id,
    )
    if (!customCat) return []
    const idSet = new Set(customCat.agentIds)
    return rootAgents.filter((a) => idSet.has(a.id))
  }, [selectedCategory, rootAgents, customCategories])

  const selectCategory = useCallback((sel: CategorySelection) => {
    setSelectedCategory(sel)
    setSelectionPath([])
    setActiveColumn(1)
  }, [])

  const selectAgentAtDepth = useCallback(
    (agentId: string, depth: number) => {
      setSelectionPath((prev) => [...prev.slice(0, depth), agentId])
      setActiveColumn(depth + 2) // +2 because column 0 is categories
    },
    [],
  )

  const navigateBack = useCallback(
    (toColumn: number) => {
      if (toColumn <= 0) {
        setSelectedCategory(null)
        setSelectionPath([])
        setActiveColumn(0)
      } else if (toColumn === 1) {
        setSelectionPath([])
        setActiveColumn(1)
      } else {
        setSelectionPath((prev) => prev.slice(0, toColumn - 1))
        setActiveColumn(toColumn)
      }
    },
    [],
  )

  const deepestSelectedId = selectionPath.at(-1)
  const deepestSelected = deepestSelectedId
    ? allAgentsById.get(deepestSelectedId)
    : undefined

  const columns = useMemo(() => {
    const result: ReactNode[] = []

    // Column 0: categories
    result.push(
      <div
        className="h-full w-full flex-shrink-0"
        key="categories"
        style={{ width: `${100 / visibleColumns}%` }}
      >
        <AgentColumn showBack={false} title="Agent Categories">
          <CategoryColumnContent
            categories={customCategories}
            onCreateClick={() => setCreateCategoryOpen(true)}
            onSelect={selectCategory}
            selected={selectedCategory}
          />
        </AgentColumn>
      </div>,
    )

    // Column 1: agents filtered by category (only when category selected)
    if (selectedCategory) {
      const categoryLabel =
        selectedCategory.kind === 'static'
          ? STATIC_CATEGORIES.find(
              (c) => c.id === selectedCategory.id,
            )?.name ?? 'Agents'
          : customCategories.find(
              (c) => c.id === selectedCategory.id,
            )?.name ?? 'Agents'

      result.push(
        <div
          className="h-full w-full flex-shrink-0"
          key="agents"
          style={{ width: `${100 / visibleColumns}%` }}
        >
          <AgentColumn
            headerAction={
              <AgentCreateButton
                label="New agent"
                onClick={() => void navigate('/agents/designer')}
              />
            }
            onBack={() => navigateBack(0)}
            showBack={isMobile}
            title={categoryLabel}
          >
            {/* Manage agents button for custom categories */}
            {selectedCategory.kind === 'custom' && (
              <button
                className={[
                  'mb-2 flex w-full items-center justify-center',
                  'gap-1.5 rounded-lg border',
                  'border-[rgba(124,58,237,0.3)]',
                  'bg-[rgba(124,58,237,0.1)] px-3 py-2',
                  'text-xs font-medium text-[#a78bfa]',
                  'transition-colors',
                  'hover:bg-[rgba(124,58,237,0.2)]',
                ].join(' ')}
                onClick={() =>
                  setCategoryPopupId(selectedCategory.id)
                }
                type="button"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M12 5v14M5 12h14"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Manage agents
              </button>
            )}
            {filteredAgents.length === 0 ? (
              <div
                className={[
                  'px-3 py-6 text-center text-xs',
                  'text-[color:var(--tx3)]',
                ].join(' ')}
              >
                No agents in this category
              </div>
            ) : (
              filteredAgents.map((agent) => (
                <AgentColumnItem
                  agent={agent}
                  hasChildren
                  isSelected={selectionPath[0] === agent.id}
                  key={agent.id}
                  onClick={() => selectAgentAtDepth(agent.id, 0)}
                />
              ))
            )}
          </AgentColumn>
        </div>,
      )
    }

    // Columns 2..N: children of each agent in the selection path
    for (let depth = 0; depth < selectionPath.length; depth++) {
      const parentId = selectionPath[depth]
      if (!parentId) {
        continue
      }
      const parentAgent = allAgentsById.get(parentId)
      const nextSelectedId = selectionPath[depth + 1]

      result.push(
        <div
          className="h-full w-full flex-shrink-0"
          key={`children-${parentId}`}
          style={{ width: `${100 / visibleColumns}%` }}
        >
          <AgentColumn
            headerAction={
              <AgentCreateButton
                label="Create sub-agent"
                onClick={() =>
                  void navigate(`/agents/designer?parentId=${parentId}`)
                }
              />
            }
            onBack={() => navigateBack(depth + 1)}
            showBack={isMobile}
            title={parentAgent?.name ?? 'Children'}
          >
            {parentAgent && (
              <AgentChildrenHeader
                onOpenPopup={() =>
                  setSubAgentPopupAgentId(parentId)
                }
                parentAgent={parentAgent}
                parentId={parentId}
              />
            )}
            <AgentChildrenList
              onSelect={(child) =>
                selectAgentAtDepth(child.agentId, depth + 1)
              }
              parentId={parentId}
              selectedId={nextSelectedId}
            />
          </AgentColumn>
        </div>,
      )
    }

    // Final column: detail view of deepest selected agent
    if (deepestSelected) {
      result.push(
        <div
          className="h-full w-full flex-shrink-0"
          key={`detail-${deepestSelected.id}`}
          style={{ width: `${100 / visibleColumns}%` }}
        >
          <AgentDetailColumn
            agent={deepestSelected}
            onBack={() =>
              navigateBack(selectionPath.length + 1)
            }
            showBack={isMobile}
          />
        </div>,
      )
    }

    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allAgentsById,
    customCategories,
    deepestSelected,
    filteredAgents,
    isMobile,
    navigateBack,
    selectAgentAtDepth,
    selectCategory,
    selectedCategory,
    selectionPath,
    visibleColumns,
  ])

  const totalColumns = columns.length

  const translateX = useMemo(() => {
    const columnWidthPercent = 100 / visibleColumns

    if (isMobile) {
      return -(activeColumn * 100)
    }

    const desktopStartIndex = Math.max(
      0,
      Math.min(
        activeColumn - (visibleColumns - 1),
        totalColumns - visibleColumns,
      ),
    )
    return -(desktopStartIndex * columnWidthPercent)
  }, [activeColumn, isMobile, totalColumns, visibleColumns])

  const popupAgent = subAgentPopupAgentId
    ? allAgentsById.get(subAgentPopupAgentId)
    : undefined

  const popupCategory = categoryPopupId
    ? customCategories.find((c) => c.id === categoryPopupId)
    : undefined

  return (
    <div className="h-full w-full overflow-hidden">
      <div
        className={[
          'flex h-full transition-transform duration-300 ease-out',
        ].join(' ')}
        style={{ transform: `translateX(${translateX}%)` }}
      >
        {columns}
      </div>

      {subAgentPopupAgentId && popupAgent && (
        <SubAgentPopup
          onClose={() => setSubAgentPopupAgentId(null)}
          parentAgentId={subAgentPopupAgentId}
          parentAgentName={popupAgent.name}
        />
      )}

      {categoryPopupId && popupCategory && (
        <CategoryAgentsPopup
          allAgents={rootAgents}
          category={popupCategory}
          onClose={() => setCategoryPopupId(null)}
        />
      )}

      <CreateCategoryDialog
        onClose={() => setCreateCategoryOpen(false)}
        open={createCategoryOpen}
      />
    </div>
  )
}
