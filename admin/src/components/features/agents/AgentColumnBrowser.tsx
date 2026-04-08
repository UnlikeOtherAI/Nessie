import { type ReactNode, useCallback, useMemo, useState } from 'react'
import type { AgentChild } from '@nessie/schemas'
import { useAgentChildren, useAgents } from '../../../facades/agents/hooks'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import type { AgentRecord } from '../../../lib/api-client'
import { AgentColumn } from './AgentColumn'
import { AgentColumnItem } from './AgentColumnItem'
import { AgentDetailColumn } from './AgentDetailColumn'
import { AgentStatusDot } from './AgentStatusDot'
import { SubAgentPopup } from './SubAgentPopup'

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
      <div className="px-3 py-6 text-center text-xs text-[color:var(--tx3)]">
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
    <div className="mb-2 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AgentStatusDot status={parentAgent.status} />
          <div>
            <div className="text-sm font-medium text-white">{parentAgent.name}</div>
            <div className="text-xs text-[color:var(--tx3)]">{parentAgent.role}</div>
          </div>
        </div>
        <button
          className="flex items-center gap-0.5 rounded-full px-1 py-0.5 transition-colors hover:bg-white/10"
          onClick={onOpenPopup}
          title="Manage sub-agents"
          type="button"
        >
          <div className="flex items-center -space-x-1.5">
            {displayedChildren.map((child) => (
              <div
                className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-[color:var(--panel)] text-[10px]"
                key={child.agentId}
                style={{ background: agentGradient }}
                title={child.name}
              >
                {getAgentGlyph(child.status)}
              </div>
            ))}
          </div>
          <div className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-[color:var(--panel)] bg-white/10 text-xs text-[color:var(--tx3)]">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </button>
      </div>
    </div>
  )
}

export const AgentColumnBrowser = () => {
  const { data: agents = [] } = useAgents()
  const [selectionPath, setSelectionPath] = useState<string[]>([])
  const [activeColumn, setActiveColumn] = useState(0)
  const [subAgentPopupAgentId, setSubAgentPopupAgentId] = useState<string | null>(null)

  const isMobile = useMediaQuery('(max-width: 767px)')
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)')

  const visibleColumns = isMobile ? 1 : isTablet ? 2 : 3

  const rootAgents = useMemo(
    () => agents.filter((a) => !a.parentAgentId),
    [agents],
  )

  const allAgentsById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  )

  const selectAtDepth = useCallback(
    (agentId: string, depth: number) => {
      setSelectionPath((prev) => [...prev.slice(0, depth), agentId])
      setActiveColumn(depth + 1)
    },
    [],
  )

  const navigateBack = useCallback((toDepth: number) => {
    setSelectionPath((prev) => prev.slice(0, toDepth))
    setActiveColumn(toDepth)
  }, [])

  const deepestSelected = selectionPath.length > 0
    ? allAgentsById.get(selectionPath[selectionPath.length - 1])
    : undefined

  const columns = useMemo(() => {
    const result: ReactNode[] = []

    // Column 0: root agents
    result.push(
      <div className="h-full w-full flex-shrink-0" key="root" style={{ width: `${100 / visibleColumns}%` }}>
        <AgentColumn showBack={false} title="Agents">
          {rootAgents.map((agent) => (
            <AgentColumnItem
              agent={agent}
              hasChildren
              isSelected={selectionPath[0] === agent.id}
              key={agent.id}
              onClick={() => selectAtDepth(agent.id, 0)}
            />
          ))}
        </AgentColumn>
      </div>,
    )

    // Columns 1..N: children of each agent in the selection path
    for (let depth = 0; depth < selectionPath.length; depth++) {
      const parentId = selectionPath[depth]
      const parentAgent = allAgentsById.get(parentId)
      const nextSelectedId = selectionPath[depth + 1]

      result.push(
        <div
          className="h-full w-full flex-shrink-0"
          key={`children-${parentId}`}
          style={{ width: `${100 / visibleColumns}%` }}
        >
          <AgentColumn
            onBack={() => navigateBack(depth)}
            showBack={isMobile}
            title={parentAgent?.name ?? 'Children'}
          >
            {parentAgent && (
              <AgentChildrenHeader
                onOpenPopup={() => setSubAgentPopupAgentId(parentId)}
                parentAgent={parentAgent}
                parentId={parentId}
              />
            )}
            <AgentChildrenList
              onSelect={(child) => selectAtDepth(child.agentId, depth + 1)}
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
            onBack={() => navigateBack(selectionPath.length)}
            showBack={isMobile}
          />
        </div>,
      )
    }

    return result
  }, [
    allAgentsById,
    deepestSelected,
    isMobile,
    navigateBack,
    rootAgents,
    selectAtDepth,
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

  return (
    <div className="h-full w-full overflow-hidden">
      <div
        className="flex h-full transition-transform duration-300 ease-out"
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
    </div>
  )
}
