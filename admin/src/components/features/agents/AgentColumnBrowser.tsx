import { type ReactNode, useCallback, useMemo, useState } from 'react'
import type { AgentChild } from '@nessie/schemas'
import { useNavigate } from 'react-router-dom'
import { useAgentChildren, useAgents } from '../../../facades/agents/hooks'
import { useMediaQuery } from '../../../hooks/useMediaQuery'
import type { AgentRecord } from '../../../lib/api-client'
import { ColumnBrowserViewport } from '../../shared/column-browser/ColumnBrowserViewport'
import { AgentColumn } from './AgentColumn'
import { AgentCreateButton } from './AgentCreateButton'
import { AgentColumnItem } from './AgentColumnItem'
import { AgentDetailColumn } from './AgentDetailColumn'
import { AgentStatusDot } from './AgentStatusDot'
import { SubAgentPopup } from './SubAgentPopup'
import { agentGradient } from '../../../lib/avatar'

type AgentChildrenListProps = {
  childCountByParentId: Map<string, number>
  onSelect: (child: AgentChild) => void
  parentId: string
  selectedId?: string
}

const AgentChildrenList = ({
  childCountByParentId,
  onSelect,
  parentId,
  selectedId,
}: AgentChildrenListProps) => {
  const { data: children = [] } = useAgentChildren(parentId)

  if (children.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
        No child agents.
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {children.map((child) => (
        <AgentColumnItem
          agent={child}
          childCount={childCountByParentId.get(child.agentId) ?? 0}
          isSelected={child.agentId === selectedId}
          key={child.agentId}
          onClick={() => onSelect(child)}
        />
      ))}
    </div>
  )
}

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
    <div className="mb-3 rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AgentStatusDot status={parentAgent.status} />
          <div>
            <div className="text-sm font-medium text-[var(--tx)]">
              {parentAgent.name}
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              {parentAgent.role}
            </div>
          </div>
        </div>
        <button
          className="flex items-center gap-0.5 rounded-full px-1 py-0.5 transition-colors hover:bg-[var(--overlay)]"
          onClick={onOpenPopup}
          title="Manage sub-agents"
          type="button"
        >
          <div className="flex items-center -space-x-1.5">
            {displayedChildren.map((child) => (
              <div
                className={[
                  'flex h-[22px] w-[22px] items-center justify-center',
                  'rounded-full border-2 border-[color:var(--main)] text-[10px]',
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
              'flex h-[22px] w-[22px] items-center justify-center rounded-full',
              'border-2 border-[color:var(--main)] bg-[var(--overlay)] text-xs',
              'text-[color:var(--tx3)]',
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

export const AgentColumnBrowser = () => {
  const navigate = useNavigate()
  const { data: agents = [] } = useAgents()

  const [selectionPath, setSelectionPath] = useState<string[]>([])
  const [activeColumn, setActiveColumn] = useState(0)
  const [subAgentPopupAgentId, setSubAgentPopupAgentId] = useState<
    string | null
  >(null)
  const isMobile = useMediaQuery('(max-width: 767px)')

  const rootAgents = useMemo(
    () =>
      agents
        .filter((agent) => !agent.parentAgentId)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [agents],
  )

  const allAgentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )

  const childCountByParentId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const agent of agents) {
      if (!agent.parentAgentId) continue
      counts.set(agent.parentAgentId, (counts.get(agent.parentAgentId) ?? 0) + 1)
    }
    return counts
  }, [agents])

  const getChildCount = useCallback(
    (agentId: string): number => childCountByParentId.get(agentId) ?? 0,
    [childCountByParentId],
  )

  const selectAgentAtDepth = useCallback(
    (agentId: string, depth: number) => {
      setSelectionPath((prev) => [...prev.slice(0, depth), agentId])
      setActiveColumn(depth + 1)
    },
    [],
  )

  const deepestSelectedId = selectionPath.at(-1)
  const deepestSelected = deepestSelectedId
    ? allAgentsById.get(deepestSelectedId)
    : undefined

  const columns = useMemo(() => {
    const result: ReactNode[] = []

    result.push(
      <AgentColumn
        headerAction={
          <AgentCreateButton
            label="New agent"
            onClick={() => void navigate('/agents/designer')}
          />
        }
        key="agents"
        showBack={false}
        title="All agents"
      >
        {rootAgents.length === 0 ? (
          <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
            No agents yet.
          </div>
        ) : (
          <div className="grid gap-3">
            {rootAgents.map((agent) => (
              <AgentColumnItem
                agent={agent}
                childCount={childCountByParentId.get(agent.id) ?? 0}
                isSelected={selectionPath[0] === agent.id}
                key={agent.id}
                onClick={() => selectAgentAtDepth(agent.id, 0)}
              />
            ))}
          </div>
        )}
      </AgentColumn>,
    )

    for (let depth = 0; depth < selectionPath.length; depth++) {
      const parentId = selectionPath[depth]
      if (!parentId) continue
      if (getChildCount(parentId) === 0) continue
      const parentAgent = allAgentsById.get(parentId)
      const nextSelectedId = selectionPath[depth + 1]

      result.push(
        <AgentColumn
          headerAction={
            <AgentCreateButton
              label="Create sub-agent"
              onClick={() =>
                void navigate(`/agents/designer?parentId=${parentId}`)
              }
            />
          }
          key={`children-${parentId}`}
          onBack={() => {
            setSelectionPath((prev) => prev.slice(0, depth))
            setActiveColumn(depth)
          }}
          showBack={isMobile}
          title={parentAgent?.name ?? 'Children'}
        >
          {parentAgent ? (
            <AgentChildrenHeader
              onOpenPopup={() => setSubAgentPopupAgentId(parentId)}
              parentAgent={parentAgent}
              parentId={parentId}
            />
          ) : null}
          <AgentChildrenList
            childCountByParentId={childCountByParentId}
            onSelect={(child) => selectAgentAtDepth(child.agentId, depth + 1)}
            parentId={parentId}
            selectedId={nextSelectedId}
          />
        </AgentColumn>,
      )
    }

    if (deepestSelected) {
      const detailBackColumn = selectionPath.reduce(
        (count, selectedId) => count + (getChildCount(selectedId) > 0 ? 1 : 0),
        0,
      )

      result.push(
        <AgentDetailColumn
          agent={deepestSelected}
          key={`detail-${deepestSelected.id}`}
          onBack={() => setActiveColumn(detailBackColumn)}
          showBack={isMobile}
        />,
      )
    }

    return result
  }, [
    allAgentsById,
    childCountByParentId,
    deepestSelected,
    getChildCount,
    isMobile,
    navigate,
    rootAgents,
    selectAgentAtDepth,
    selectionPath,
  ])

  const popupAgent = subAgentPopupAgentId
    ? allAgentsById.get(subAgentPopupAgentId)
    : undefined

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={activeColumn} columns={columns} />

      {subAgentPopupAgentId && popupAgent ? (
        <SubAgentPopup
          onClose={() => setSubAgentPopupAgentId(null)}
          parentAgentId={subAgentPopupAgentId}
          parentAgentName={popupAgent.name}
        />
      ) : null}
    </div>
  )
}
