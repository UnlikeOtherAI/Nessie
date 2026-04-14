import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  faBolt,
  faChevronDown,
  faPlus,
  faRobot,
  faScrewdriverWrench,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useTriggers } from '../facades/triggers/hooks'
import { useTools } from '../facades/tools/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

type WorkflowCanvasNodeType = 'agent' | 'tool' | 'trigger'

type ToolbarMenuItem = {
  icon: IconDefinition
  key: string
  label: string
  meta?: string
  nodeType?: WorkflowCanvasNodeType
  state?: { returnTo: string }
  to?: string
}

type ToolbarAction = {
  createItem?: ToolbarMenuItem
  emptyLabel: string
  icon: IconDefinition
  items: ToolbarMenuItem[]
  key: string
  label: string
  sectionLabel: string
}

type WorkflowCanvasNode = {
  id: string
  label: string
  meta?: string
  type: WorkflowCanvasNodeType
  x: number
  y: number
}

type WorkflowConnection = {
  fromNodeId: string
  id: string
  toNodeId: string
}

type WorkflowDraftConnection = {
  fromNodeId: string
  startX: number
  startY: number
  x: number
  y: number
}

const toolbarButtonClass = [
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-black/10',
  'bg-white px-2.5 text-[11px] font-medium text-[#433349] transition-colors',
  'hover:bg-[#f4eff8]',
].join(' ')

const menuItemClass = [
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
  'text-[#433349] transition-colors hover:bg-[#f4eff8]',
].join(' ')

const sectionLabelClass =
  'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8b7a93]'

const dividerClass = 'my-1 border-t border-black/8'

const canvasClass = [
  'relative flex-1 overflow-hidden bg-white',
  'bg-[radial-gradient(circle_at_1px_1px,rgba(116,69,199,0.12)_1px,transparent_0)]',
  '[background-size:28px_28px]',
].join(' ')

const CANVAS_PADDING = 24
const CANVAS_NODE_WIDTH = 244
const CANVAS_NODE_HEIGHT = 96
const CANVAS_NODE_HANDLE_Y = 48
const CANVAS_NODE_INSERT_OFFSET = 28
const CANVAS_NODE_INSERT_STEPS = 6

const nodeThemes: Record<
  WorkflowCanvasNodeType,
  {
    badgeBackground: string
    border: string
    fill: string
    label: string
  }
> = {
  agent: {
    badgeBackground: '#f1e9ff',
    border: '#7445c7',
    fill: '#fbf8ff',
    label: 'Agent',
  },
  tool: {
    badgeBackground: '#e8f6ff',
    border: '#2b8ac6',
    fill: '#f8fcff',
    label: 'Tool',
  },
  trigger: {
    badgeBackground: '#fff1df',
    border: '#d97706',
    fill: '#fffaf2',
    label: 'Trigger',
  },
}

const normalizeReturnTo = (pathname: string, search: string, hash: string) =>
  `${pathname}${search}${hash}`

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const getNodeInputAnchor = (node: WorkflowCanvasNode) => ({
  x: node.x,
  y: node.y + CANVAS_NODE_HANDLE_Y,
})

const getNodeOutputAnchor = (node: WorkflowCanvasNode) => ({
  x: node.x + CANVAS_NODE_WIDTH,
  y: node.y + CANVAS_NODE_HANDLE_Y,
})

const buildConnectionPath = (
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const curveOffset = Math.max(Math.abs(end.x - start.x) * 0.45, 64)
  return [
    `M ${start.x} ${start.y}`,
    `C ${start.x + curveOffset} ${start.y},`,
    `${end.x - curveOffset} ${end.y},`,
    `${end.x} ${end.y}`,
  ].join(' ')
}

const getCanvasInsertionPoint = (canvasElement: HTMLDivElement | null, offset: number) => {
  if (!canvasElement) {
    return {
      x: CANVAS_PADDING + offset,
      y: CANVAS_PADDING + offset,
    }
  }

  const canvasBounds = canvasElement.getBoundingClientRect()
  const maxX = Math.max(
    CANVAS_PADDING,
    canvasBounds.width - CANVAS_NODE_WIDTH - CANVAS_PADDING,
  )
  const maxY = Math.max(
    CANVAS_PADDING,
    canvasBounds.height - CANVAS_NODE_HEIGHT - CANVAS_PADDING,
  )

  return {
    x: clamp(
      canvasBounds.width / 2 - CANVAS_NODE_WIDTH / 2 + offset,
      CANVAS_PADDING,
      maxX,
    ),
    y: clamp(
      canvasBounds.height / 2 - CANVAS_NODE_HEIGHT / 2 + offset,
      CANVAS_PADDING,
      maxY,
    ),
  }
}

export const WorkflowDesignerPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { me } = useAuthSession()
  const { data: agents = [] } = useAgents()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useTriggers(isOwner)
  const { data: tools = [] } = useTools()

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    offsetX: number
    offsetY: number
    nodeId: string
  } | null>(null)
  const nextInsertOffsetRef = useRef(0)

  const [connections, setConnections] = useState<WorkflowConnection[]>([])
  const [draftConnection, setDraftConnection] = useState<WorkflowDraftConnection | null>(null)
  const [nodes, setNodes] = useState<WorkflowCanvasNode[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const returnTo = normalizeReturnTo(
    location.pathname,
    location.search,
    location.hash,
  )

  const toolbarActions = useMemo<ToolbarAction[]>(() => {
    const topLevelAgents = [...agents]
      .filter((agent) => !agent.parentAgentId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((agent) => ({
        icon: faRobot,
        key: agent.id,
        label: agent.name,
        meta: agent.role,
        nodeType: 'agent' as const,
      }))

    const allTriggers = [...triggers]
      .sort((left, right) =>
        (left.name ?? left.type).localeCompare(right.name ?? right.type),
      )
      .map((trigger) => ({
        icon: faBolt,
        key: trigger.id,
        label: trigger.name ?? trigger.type,
        meta: trigger.type,
        nodeType: 'trigger' as const,
      }))

    const allTools = [...tools]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((tool) => ({
        icon: faScrewdriverWrench,
        key: tool.id,
        label: tool.label,
        meta: tool.safe ? 'safe' : 'restricted',
        nodeType: 'tool' as const,
      }))

    return [
      {
        createItem: {
          icon: faPlus,
          key: 'new-trigger',
          label: 'New trigger',
        },
        emptyLabel: 'No triggers yet',
        icon: faBolt,
        items: allTriggers,
        key: 'trigger',
        label: 'Trigger',
        sectionLabel: 'All triggers',
      },
      {
        createItem: {
          icon: faPlus,
          key: 'new-tool',
          label: 'New tool',
        },
        emptyLabel: 'No tools yet',
        icon: faScrewdriverWrench,
        items: allTools,
        key: 'tools',
        label: 'Tools',
        sectionLabel: 'All tools',
      },
      {
        createItem: {
          icon: faPlus,
          key: 'new-agent',
          label: 'New agent',
          state: { returnTo },
          to: '/agents/designer',
        },
        emptyLabel: 'No top-level agents',
        icon: faRobot,
        items: topLevelAgents,
        key: 'agents',
        label: 'Agents',
        sectionLabel: 'Top-level agents',
      },
    ]
  }, [agents, returnTo, tools, triggers])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      if (target.closest('[data-workflow-menu-root="true"]')) {
        return
      }

      setOpenMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDraftConnection(null)
        setOpenMenu(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handlePointerDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (dragStateRef.current && canvasRef.current) {
        const canvasBounds = canvasRef.current.getBoundingClientRect()
        const maxX = Math.max(
          CANVAS_PADDING,
          canvasBounds.width - CANVAS_NODE_WIDTH - CANVAS_PADDING,
        )
        const maxY = Math.max(
          CANVAS_PADDING,
          canvasBounds.height - CANVAS_NODE_HEIGHT - CANVAS_PADDING,
        )

        setNodes((currentNodes) =>
          currentNodes.map((node) =>
            node.id === dragStateRef.current?.nodeId
              ? {
                  ...node,
                  x: clamp(
                    event.clientX - canvasBounds.left - dragStateRef.current.offsetX,
                    CANVAS_PADDING,
                    maxX,
                  ),
                  y: clamp(
                    event.clientY - canvasBounds.top - dragStateRef.current.offsetY,
                    CANVAS_PADDING,
                    maxY,
                  ),
                }
              : node,
          ),
        )
      }

      if (draftConnection && canvasRef.current) {
        const canvasBounds = canvasRef.current.getBoundingClientRect()
        setDraftConnection((currentDraft) =>
          currentDraft
            ? {
                ...currentDraft,
                x: event.clientX - canvasBounds.left,
                y: event.clientY - canvasBounds.top,
              }
            : currentDraft,
        )
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      dragStateRef.current = null

      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-workflow-input-handle="true"]')
      ) {
        return
      }

      setDraftConnection(null)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draftConnection])

  const addNodeFromItem = (item: ToolbarMenuItem) => {
    if (!item.nodeType) {
      return
    }

    const nodeType = item.nodeType
    const offset = nextInsertOffsetRef.current
    nextInsertOffsetRef.current =
      (nextInsertOffsetRef.current + CANVAS_NODE_INSERT_OFFSET) %
      (CANVAS_NODE_INSERT_OFFSET * CANVAS_NODE_INSERT_STEPS)

    const insertionPoint = getCanvasInsertionPoint(canvasRef.current, offset)

    setNodes((currentNodes) => [
      ...currentNodes,
      {
        id: crypto.randomUUID(),
        label: item.label,
        meta: item.meta,
        type: nodeType,
        x: insertionPoint.x,
        y: insertionPoint.y,
      },
    ])
  }

  const handleMenuItemClick = (item: ToolbarMenuItem) => {
    setOpenMenu(null)

    if (item.nodeType) {
      addNodeFromItem(item)
      return
    }

    if (!item.to) {
      return
    }

    void navigate(item.to, item.state ? { state: item.state } : undefined)
  }

  const handleNodePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    nodeId: string,
  ) => {
    if (event.button !== 0 || !canvasRef.current) {
      return
    }

    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node) {
      return
    }

    const canvasBounds = canvasRef.current.getBoundingClientRect()
    dragStateRef.current = {
      nodeId,
      offsetX: event.clientX - canvasBounds.left - node.x,
      offsetY: event.clientY - canvasBounds.top - node.y,
    }
  }

  const handleConnectionStart = (
    event: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const node = nodes.find((candidate) => candidate.id === nodeId)
    const canvasBounds = canvasRef.current?.getBoundingClientRect()
    if (!node || !canvasBounds) {
      return
    }

    const outputAnchor = getNodeOutputAnchor(node)
    setDraftConnection({
      fromNodeId: nodeId,
      startX: outputAnchor.x,
      startY: outputAnchor.y,
      x: event.clientX - canvasBounds.left,
      y: event.clientY - canvasBounds.top,
    })
  }

  const handleConnectionComplete = (
    event: ReactPointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    setDraftConnection((currentDraft) => {
      if (!currentDraft || currentDraft.fromNodeId === nodeId) {
        return null
      }

      setConnections((currentConnections) => {
        const duplicateConnection = currentConnections.some(
          (connection) =>
            connection.fromNodeId === currentDraft.fromNodeId &&
            connection.toNodeId === nodeId,
        )

        if (duplicateConnection) {
          return currentConnections
        }

        return [
          ...currentConnections,
          {
            fromNodeId: currentDraft.fromNodeId,
            id: crypto.randomUUID(),
            toNodeId: nodeId,
          },
        ]
      })

      return null
    })
  }

  return (
    <div aria-label="Workflow Designer" className="flex h-full w-full flex-col bg-white">
      <header className="flex h-12 items-center gap-2 border-b border-black/8 bg-[#faf8fc] px-4">
        {toolbarActions.map((action) => {
          const isOpen = openMenu === action.key

          return (
            <div
              key={action.key}
              className="relative"
              data-workflow-menu-root="true"
            >
              <button
                aria-expanded={isOpen}
                aria-haspopup="menu"
                aria-label={action.label}
                className={toolbarButtonClass}
                onClick={() => setOpenMenu(isOpen ? null : action.key)}
                type="button"
              >
                <FontAwesomeIcon className="text-[11px]" fixedWidth icon={action.icon} />
                <span>{action.label}</span>
                <FontAwesomeIcon
                  className={[
                    'text-[10px] text-[#6f5b77] transition-transform',
                    isOpen ? 'rotate-180' : '',
                  ].join(' ')}
                  fixedWidth
                  icon={faChevronDown}
                />
              </button>

              {isOpen ? (
                <div
                  className="absolute left-0 top-full z-10 mt-1 w-64 rounded-lg border border-black/10 bg-white p-1 shadow-[0_12px_30px_rgba(31,22,38,0.14)]"
                  role="menu"
                >
                  {action.createItem ? (
                    <button
                      className={menuItemClass}
                      onClick={() => handleMenuItemClick(action.createItem!)}
                      role="menuitem"
                      type="button"
                    >
                      <FontAwesomeIcon
                        className="text-[12px]"
                        fixedWidth
                        icon={action.createItem.icon}
                      />
                      <span className="truncate text-[11px]">
                        {action.createItem.label}
                      </span>
                    </button>
                  ) : null}

                  {action.createItem ? <div className={dividerClass} /> : null}

                  <div className={sectionLabelClass}>{action.sectionLabel}</div>

                  <div className="max-h-72 overflow-y-auto">
                    {action.items.length > 0 ? (
                      action.items.map((item) => (
                        <button
                          key={item.key}
                          className={menuItemClass}
                          onClick={() => handleMenuItemClick(item)}
                          role="menuitem"
                          type="button"
                        >
                          <FontAwesomeIcon
                            className="text-[12px]"
                            fixedWidth
                            icon={item.icon}
                          />
                          <span className="min-w-0 flex-1 truncate text-[11px]">
                            {item.label}
                          </span>
                          {item.meta ? (
                            <span className="truncate text-[10px] text-[#8b7a93]">
                              {item.meta}
                            </span>
                          ) : null}
                        </button>
                      ))
                    ) : (
                      <div className="px-2.5 py-2 text-[11px] text-[#8b7a93]">
                        {action.emptyLabel}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </header>

      <div ref={canvasRef} className={canvasClass}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          {connections.map((connection) => {
            const sourceNode = nodes.find((node) => node.id === connection.fromNodeId)
            const targetNode = nodes.find((node) => node.id === connection.toNodeId)

            if (!sourceNode || !targetNode) {
              return null
            }

            const sourceAnchor = getNodeOutputAnchor(sourceNode)
            const targetAnchor = getNodeInputAnchor(targetNode)
            const sourceTheme = nodeThemes[sourceNode.type]

            return (
              <path
                key={connection.id}
                d={buildConnectionPath(sourceAnchor, targetAnchor)}
                fill="none"
                stroke={sourceTheme.border}
                strokeLinecap="round"
                strokeWidth="3"
              />
            )
          })}

          {draftConnection ? (
            <path
              d={buildConnectionPath(
                { x: draftConnection.startX, y: draftConnection.startY },
                { x: draftConnection.x, y: draftConnection.y },
              )}
              fill="none"
              stroke={nodeThemes.agent.border}
              strokeDasharray="8 6"
              strokeLinecap="round"
              strokeWidth="3"
            />
          ) : null}
        </svg>

        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
            <div className="max-w-md rounded-2xl border border-dashed border-[#d6cbe0] bg-white/80 px-6 py-5 text-center shadow-[0_18px_40px_rgba(31,22,38,0.06)] backdrop-blur">
              <p className="text-[13px] font-semibold text-[#433349]">
                Select a trigger, tool, or agent to place it on the canvas.
              </p>
              <p className="mt-2 text-[11px] leading-5 text-[#7c6b86]">
                Nodes drop into the middle of the workflow and can be dragged into
                position. Connect them from right to left using the circular handles.
              </p>
            </div>
          </div>
        ) : null}

        {nodes.map((node) => {
          const theme = nodeThemes[node.type]

          return (
            <div
              key={node.id}
              className="absolute cursor-grab rounded-2xl border bg-white shadow-[0_18px_40px_rgba(31,22,38,0.12)] active:cursor-grabbing"
              onPointerDown={(event) => handleNodePointerDown(event, node.id)}
              style={{
                backgroundColor: theme.fill,
                borderColor: theme.border,
                height: CANVAS_NODE_HEIGHT,
                left: node.x,
                top: node.y,
                width: CANVAS_NODE_WIDTH,
              }}
            >
              {node.type !== 'trigger' ? (
                <button
                  aria-label={`Connect into ${node.label}`}
                  className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 bg-white transition-all hover:scale-110 hover:bg-current"
                  data-workflow-handle="true"
                  data-workflow-input-handle="true"
                  onPointerUp={(event) => handleConnectionComplete(event, node.id)}
                  style={{ borderColor: theme.border, color: theme.border }}
                  type="button"
                />
              ) : null}

              <button
                aria-label={`Connect from ${node.label}`}
                className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 bg-white transition-all hover:scale-110 hover:bg-current"
                data-workflow-handle="true"
                onPointerDown={(event) => handleConnectionStart(event, node.id)}
                style={{ borderColor: theme.border, color: theme.border }}
                type="button"
              />

              <div className="flex h-full flex-col px-4 py-3">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-xl"
                    style={{ backgroundColor: theme.badgeBackground, color: theme.border }}
                  >
                    <FontAwesomeIcon
                      fixedWidth
                      icon={
                        node.type === 'trigger'
                          ? faBolt
                          : node.type === 'tool'
                            ? faScrewdriverWrench
                            : faRobot
                      }
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-[#2f2237]">
                      {node.label}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                        style={{
                          backgroundColor: theme.badgeBackground,
                          color: theme.border,
                        }}
                      >
                        {theme.label}
                      </span>
                      {node.meta ? (
                        <span className="truncate text-[10px] text-[#6f5b77]">
                          {node.meta}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="mt-auto text-[11px] leading-5 text-[#6f5b77]">
                  Drag to position. Use the connector circles to build the workflow.
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
