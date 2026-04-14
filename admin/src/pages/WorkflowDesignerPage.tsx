import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  faBolt,
  faCheck,
  faChevronDown,
  faPlus,
  faRobot,
  faScrewdriverWrench,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useTriggers } from '../facades/triggers/hooks'
import { useTools } from '../facades/tools/hooks'
import {
  useCreateWorkflowTemplate,
  useUpdateWorkflowTemplate,
  useWorkflowTemplate,
} from '../facades/workflows/hooks'
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
  sourceId: string
  type: WorkflowCanvasNodeType
  x: number
  y: number
}

type WorkflowConnection = {
  fromNodeId: string
  id: string
  toNodeId: string
}

type WorkflowConnectionCandidate = {
  fromNodeId: string
  toNodeId: string
}

type WorkflowConnectionLayout = {
  color: string
  id: string
  midpoint: { x: number; y: number }
  path: string
}

type WorkflowDraftConnection = {
  color: string
  startHandleKind: 'input' | 'output'
  startNodeId: string
  startX: number
  startY: number
  x: number
  y: number
}

type WorkflowHoveredHandle = {
  kind: 'input' | 'output'
  nodeId: string
}

type WorkflowDesignerDraft = {
  connections: WorkflowConnection[]
  nodes: WorkflowCanvasNode[]
  workflowName: string
}

type WorkflowDesignerSerializedNode = {
  meta?: string
  outgoingNodeIds: string[]
  position?: {
    x?: number
    y?: number
  }
  sourceId?: string
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
  'relative flex-1 overflow-hidden bg-white select-none',
  'bg-[radial-gradient(circle_at_1px_1px,rgba(116,69,199,0.12)_1px,transparent_0)]',
  '[background-size:28px_28px]',
].join(' ')

const CANVAS_PADDING = 24
const CANVAS_NODE_WIDTH = 244
const CANVAS_NODE_HEIGHT = 96
const CANVAS_NODE_HANDLE_Y = 48
const CANVAS_NODE_HANDLE_OFFSET_Y = -5
const CANVAS_NODE_INSERT_OFFSET = 28
const CANVAS_NODE_INSERT_STEPS = 6
const DEFAULT_WORKFLOW_NAME = 'Untitled workflow'
const WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY = 'nessie.admin.workflow-designer.draft'

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const getNodeInputAnchor = (node: WorkflowCanvasNode) => ({
  x: node.x,
  y: node.y + CANVAS_NODE_HANDLE_Y + CANVAS_NODE_HANDLE_OFFSET_Y,
})

const getNodeOutputAnchor = (node: WorkflowCanvasNode) => ({
  x: node.x + CANVAS_NODE_WIDTH,
  y: node.y + CANVAS_NODE_HANDLE_Y + CANVAS_NODE_HANDLE_OFFSET_Y,
})

const getConnectionGeometry = (
  start: { x: number; y: number },
  end: { x: number; y: number },
) => {
  const curveOffset = Math.max(Math.abs(end.x - start.x) * 0.45, 64)
  const startControl = {
    x: start.x + curveOffset,
    y: start.y,
  }
  const endControl = {
    x: end.x - curveOffset,
    y: end.y,
  }

  const midpoint = {
    x:
      start.x * 0.125 +
      startControl.x * 0.375 +
      endControl.x * 0.375 +
      end.x * 0.125,
    y:
      start.y * 0.125 +
      startControl.y * 0.375 +
      endControl.y * 0.375 +
      end.y * 0.125,
  }

  return {
    midpoint,
    path: [
      `M ${start.x} ${start.y}`,
      `C ${startControl.x} ${startControl.y},`,
      `${endControl.x} ${endControl.y},`,
      `${end.x} ${end.y}`,
    ].join(' '),
  }
}

const getOppositeHandleKind = (handleKind: 'input' | 'output') =>
  handleKind === 'input' ? 'output' : 'input'

const readSerializedNode = (value: unknown): WorkflowDesignerSerializedNode => {
  if (!isRecord(value)) {
    return {
      outgoingNodeIds: [],
    }
  }

  const positionValue = isRecord(value.position) ? value.position : undefined
  return {
    meta: typeof value.meta === 'string' ? value.meta : undefined,
    outgoingNodeIds: Array.isArray(value.outgoingNodeIds)
      ? value.outgoingNodeIds.filter(
          (nodeId): nodeId is string => typeof nodeId === 'string',
        )
      : [],
    position: positionValue
      ? {
          x: typeof positionValue.x === 'number' ? positionValue.x : undefined,
          y: typeof positionValue.y === 'number' ? positionValue.y : undefined,
        }
      : undefined,
    sourceId: typeof value.sourceId === 'string' ? value.sourceId : undefined,
  }
}

const getDraftConnectionCandidate = (
  draftConnection: WorkflowDraftConnection,
  hoveredHandle: WorkflowHoveredHandle | null,
) : WorkflowConnectionCandidate | null => {
  if (!hoveredHandle) {
    return null
  }

  const expectedTargetHandleKind = getOppositeHandleKind(
    draftConnection.startHandleKind,
  )
  if (hoveredHandle.kind !== expectedTargetHandleKind) {
    return null
  }

  if (draftConnection.startHandleKind === 'output') {
    return {
      fromNodeId: draftConnection.startNodeId,
      toNodeId: hoveredHandle.nodeId,
    }
  }

  return {
    fromNodeId: hoveredHandle.nodeId,
    toNodeId: draftConnection.startNodeId,
  }
}

const isInvalidWorkflowConnection = (
  candidateConnection: WorkflowConnectionCandidate,
  connections: WorkflowConnection[],
) =>
  candidateConnection.fromNodeId === candidateConnection.toNodeId ||
  connections.some(
    (connection) =>
      connection.fromNodeId === candidateConnection.fromNodeId &&
      connection.toNodeId === candidateConnection.toNodeId,
  )

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

const loadWorkflowDraft = (): WorkflowDesignerDraft | null => {
  try {
    const rawDraft = window.localStorage.getItem(WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY)
    if (!rawDraft) {
      return null
    }

    const parsedDraft = JSON.parse(rawDraft) as unknown
    if (!isRecord(parsedDraft)) {
      return null
    }

    const workflowName =
      typeof parsedDraft.workflowName === 'string' && parsedDraft.workflowName.trim()
        ? parsedDraft.workflowName
        : DEFAULT_WORKFLOW_NAME

    const nodes = Array.isArray(parsedDraft.nodes)
      ? parsedDraft.nodes.flatMap((entry) => {
          if (!isRecord(entry)) {
            return []
          }

          const type = entry.type
          if (type !== 'agent' && type !== 'tool' && type !== 'trigger') {
            return []
          }

          return [
            {
              id: typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
              label:
                typeof entry.label === 'string' && entry.label.trim()
                  ? entry.label
                  : 'Untitled node',
              meta: typeof entry.meta === 'string' ? entry.meta : undefined,
              sourceId:
                typeof entry.sourceId === 'string' && entry.sourceId.trim()
                  ? entry.sourceId
                  : typeof entry.id === 'string'
                    ? entry.id
                    : crypto.randomUUID(),
              type,
              x: typeof entry.x === 'number' ? entry.x : CANVAS_PADDING,
              y: typeof entry.y === 'number' ? entry.y : CANVAS_PADDING,
            } satisfies WorkflowCanvasNode,
          ]
        })
      : []

    const connections = Array.isArray(parsedDraft.connections)
      ? parsedDraft.connections.flatMap((entry) => {
          if (!isRecord(entry)) {
            return []
          }

          if (
            typeof entry.id !== 'string' ||
            typeof entry.fromNodeId !== 'string' ||
            typeof entry.toNodeId !== 'string'
          ) {
            return []
          }

          return [
            {
              id: entry.id,
              fromNodeId: entry.fromNodeId,
              toNodeId: entry.toNodeId,
            } satisfies WorkflowConnection,
          ]
        })
      : []

    return {
      connections,
      nodes,
      workflowName,
    }
  } catch {
    return null
  }
}

const storeWorkflowDraft = (draft: WorkflowDesignerDraft) => {
  window.localStorage.setItem(
    WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY,
    JSON.stringify(draft),
  )
}

const clearWorkflowDraft = () => {
  window.localStorage.removeItem(WORKFLOW_DESIGNER_DRAFT_STORAGE_KEY)
}

const buildWorkflowGraph = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) => ({
  steps: nodes.map((node) => ({
    id: node.id,
    input: {
      workflowDesigner: {
        meta: node.meta,
        outgoingNodeIds: connections
          .filter((connection) => connection.fromNodeId === node.id)
          .map((connection) => connection.toNodeId),
        position: {
          x: Math.round(node.x),
          y: Math.round(node.y),
        },
        sourceId: node.sourceId,
      },
    },
    title: node.label,
    type: node.type,
  })),
})

const buildWorkflowTriggers = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) =>
  nodes
    .filter((node) => node.type === 'trigger')
    .map((node) => ({
      id: node.id,
      meta: node.meta,
      sourceId: node.sourceId,
      targetNodeIds: connections
        .filter((connection) => connection.fromNodeId === node.id)
        .map((connection) => connection.toNodeId),
      title: node.label,
    }))

const parseWorkflowTemplate = (
  graph: {
    steps: Array<{
      id: string
      input?: Record<string, unknown>
      title?: string
      type: string
    }>
  },
  canvasElement: HTMLDivElement | null,
): Pick<WorkflowDesignerDraft, 'connections' | 'nodes'> => {
  const parsedNodes = graph.steps.flatMap((step, index) => {
    const stepType = step.type
    if (stepType !== 'agent' && stepType !== 'tool' && stepType !== 'trigger') {
      return []
    }

    const serializedNode = readSerializedNode(
      isRecord(step.input) ? step.input.workflowDesigner : undefined,
    )
    const fallbackPosition = getCanvasInsertionPoint(
      canvasElement,
      (index % CANVAS_NODE_INSERT_STEPS) * CANVAS_NODE_INSERT_OFFSET,
    )

    return [
      {
        id: step.id,
        label: step.title?.trim() || 'Untitled node',
        meta: serializedNode.meta,
        sourceId: serializedNode.sourceId ?? step.id,
        type: stepType,
        x:
          typeof serializedNode.position?.x === 'number'
            ? serializedNode.position.x
            : fallbackPosition.x,
        y:
          typeof serializedNode.position?.y === 'number'
            ? serializedNode.position.y
            : fallbackPosition.y,
      } satisfies WorkflowCanvasNode,
    ]
  })

  const parsedConnections = parsedNodes.flatMap((node) => {
    const step = graph.steps.find((candidate) => candidate.id === node.id)
    const serializedNode = readSerializedNode(
      isRecord(step?.input) ? step.input.workflowDesigner : undefined,
    )

    return serializedNode.outgoingNodeIds.flatMap((toNodeId) =>
      parsedNodes.some((candidate) => candidate.id === toNodeId)
        ? [
            {
              id: crypto.randomUUID(),
              fromNodeId: node.id,
              toNodeId,
            } satisfies WorkflowConnection,
          ]
        : [],
    )
  })

  return {
    connections: parsedConnections,
    nodes: parsedNodes,
  }
}

export const WorkflowDesignerPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { workflowTemplateId } = useParams<{ workflowTemplateId?: string }>()
  const { me } = useAuthSession()
  const { data: agents = [] } = useAgents()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useTriggers(isOwner)
  const { data: tools = [] } = useTools()
  const {
    data: workflowTemplate,
    isLoading: isWorkflowTemplateLoading,
  } = useWorkflowTemplate(workflowTemplateId, isOwner)
  const createWorkflowTemplate = useCreateWorkflowTemplate()
  const updateWorkflowTemplate = useUpdateWorkflowTemplate()

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const hydratedWorkflowIdRef = useRef<string | null>(null)
  const lastSavedWorkflowSignatureRef = useRef<string | null>(null)
  const lastStoredDraftSignatureRef = useRef<string | null>(null)
  const dragStateRef = useRef<{
    offsetX: number
    offsetY: number
    nodeId: string
  } | null>(null)
  const nextInsertOffsetRef = useRef(0)

  const [autoSaveDraft, setAutoSaveDraft] = useState(true)
  const [connections, setConnections] = useState<WorkflowConnection[]>([])
  const [draftConnection, setDraftConnection] = useState<WorkflowDraftConnection | null>(null)
  const [hoveredHandle, setHoveredHandle] = useState<WorkflowHoveredHandle | null>(null)
  const [hoveredConnectionId, setHoveredConnectionId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<WorkflowCanvasNode[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [workflowName, setWorkflowName] = useState(DEFAULT_WORKFLOW_NAME)

  const returnTo = normalizeReturnTo(
    location.pathname,
    location.search,
    location.hash,
  )

  const workflowSignature = useMemo(
    () =>
      JSON.stringify({
        connections,
        nodes,
        workflowName: workflowName.trim(),
      }),
    [connections, nodes, workflowName],
  )

  const hasWorkflowToSave = nodes.length > 0 && workflowName.trim().length > 0
  const isSavingWorkflow =
    createWorkflowTemplate.isPending || updateWorkflowTemplate.isPending
  const hasUnsavedChanges =
    hasWorkflowToSave &&
    workflowSignature !== lastSavedWorkflowSignatureRef.current

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
    if (workflowTemplateId) {
      return
    }

    if (hydratedWorkflowIdRef.current === 'draft') {
      return
    }

    hydratedWorkflowIdRef.current = 'draft'

    const draft = loadWorkflowDraft()
    if (!draft) {
      lastSavedWorkflowSignatureRef.current = null
      lastStoredDraftSignatureRef.current = JSON.stringify({
        connections: [],
        nodes: [],
        workflowName: DEFAULT_WORKFLOW_NAME,
      })
      return
    }

    setConnections(draft.connections)
    setNodes(draft.nodes)
    setWorkflowName(draft.workflowName)
    nextInsertOffsetRef.current =
      (draft.nodes.length % CANVAS_NODE_INSERT_STEPS) * CANVAS_NODE_INSERT_OFFSET
    lastSavedWorkflowSignatureRef.current = null
    lastStoredDraftSignatureRef.current = JSON.stringify({
      connections: draft.connections,
      nodes: draft.nodes,
      workflowName: draft.workflowName.trim(),
    })
  }, [workflowTemplateId])

  useEffect(() => {
    if (!workflowTemplateId || !workflowTemplate) {
      return
    }

    if (hydratedWorkflowIdRef.current === workflowTemplateId) {
      return
    }

    const parsedWorkflow = parseWorkflowTemplate(workflowTemplate.graph, canvasRef.current)
    hydratedWorkflowIdRef.current = workflowTemplateId
    setConnections(parsedWorkflow.connections)
    setNodes(parsedWorkflow.nodes)
    setWorkflowName(workflowTemplate.name)
    nextInsertOffsetRef.current =
      (parsedWorkflow.nodes.length % CANVAS_NODE_INSERT_STEPS) *
      CANVAS_NODE_INSERT_OFFSET
    lastSavedWorkflowSignatureRef.current = JSON.stringify({
      connections: parsedWorkflow.connections,
      nodes: parsedWorkflow.nodes,
      workflowName: workflowTemplate.name.trim(),
    })
    lastStoredDraftSignatureRef.current = null
    clearWorkflowDraft()
  }, [workflowTemplate, workflowTemplateId])

  const persistWorkflow = useCallback(
    async (mode: 'auto' | 'manual') => {
      if (!hasWorkflowToSave || isSavingWorkflow) {
        return null
      }

      const payload = {
        graph: buildWorkflowGraph(nodes, connections),
        name: workflowName.trim(),
        triggers: buildWorkflowTriggers(nodes, connections),
      }

      const savedWorkflow = workflowTemplateId
        ? await updateWorkflowTemplate.mutateAsync({
            ...payload,
            workflowTemplateId,
          })
        : await createWorkflowTemplate.mutateAsync(payload)

      lastSavedWorkflowSignatureRef.current = JSON.stringify({
        connections,
        nodes,
        workflowName: workflowName.trim(),
      })
      lastStoredDraftSignatureRef.current = workflowSignature
      clearWorkflowDraft()
      setSaveMessage(mode === 'auto' ? 'Draft saved' : 'Workflow saved')

      if (!workflowTemplateId) {
        void navigate(`/agents/workflow-designer/${savedWorkflow.id}`, {
          replace: true,
        })
      }

      return savedWorkflow
    },
    [
      connections,
      createWorkflowTemplate,
      hasWorkflowToSave,
      isSavingWorkflow,
      navigate,
      nodes,
      updateWorkflowTemplate,
      workflowName,
      workflowSignature,
      workflowTemplateId,
    ],
  )

  const connectionLayouts = useMemo<WorkflowConnectionLayout[]>(() => {
    return connections.flatMap((connection) => {
      const sourceNode = nodes.find((node) => node.id === connection.fromNodeId)
      const targetNode = nodes.find((node) => node.id === connection.toNodeId)

      if (!sourceNode || !targetNode) {
        return []
      }

      const sourceAnchor = getNodeOutputAnchor(sourceNode)
      const targetAnchor = getNodeInputAnchor(targetNode)
      const geometry = getConnectionGeometry(sourceAnchor, targetAnchor)

      return [
        {
          color: nodeThemes[sourceNode.type].border,
          id: connection.id,
          midpoint: geometry.midpoint,
          path: geometry.path,
        },
      ]
    })
  }, [connections, nodes])

  const invalidDraftTarget = useMemo(() => {
    if (!draftConnection || !hoveredHandle) {
      return null
    }

    if (hoveredHandle.kind === draftConnection.startHandleKind) {
      return hoveredHandle
    }

    const candidateConnection = getDraftConnectionCandidate(
      draftConnection,
      hoveredHandle,
    )
    if (!candidateConnection) {
      return null
    }

    if (isInvalidWorkflowConnection(candidateConnection, connections)) {
      return hoveredHandle
    }

    return null
  }, [connections, draftConnection, hoveredHandle])

  const finishDraftConnection = useCallback(
    (
      currentDraftConnection: WorkflowDraftConnection | null,
      currentHoveredHandle: WorkflowHoveredHandle | null,
    ) => {
      if (!currentDraftConnection) {
        return
      }

      const candidateConnection = getDraftConnectionCandidate(
        currentDraftConnection,
        currentHoveredHandle,
      )

      if (
        candidateConnection &&
        !isInvalidWorkflowConnection(candidateConnection, connections)
      ) {
        setConnections((currentConnections) => {
          if (isInvalidWorkflowConnection(candidateConnection, currentConnections)) {
            return currentConnections
          }

          return [
            ...currentConnections,
            {
              fromNodeId: candidateConnection.fromNodeId,
              id: crypto.randomUUID(),
              toNodeId: candidateConnection.toNodeId,
            },
          ]
        })
      }

      setDraftConnection(null)
      setHoveredHandle(null)
    },
    [connections],
  )

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
        setHoveredHandle(null)
        setHoveredConnectionId(null)
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
    const handleDocumentClick = () => {
      if (!draftConnection) {
        return
      }

      finishDraftConnection(draftConnection, hoveredHandle)
    }

    const handleWindowBlur = () => {
      if (!draftConnection) {
        return
      }

      finishDraftConnection(draftConnection, hoveredHandle)
    }

    document.addEventListener('click', handleDocumentClick, true)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      document.removeEventListener('click', handleDocumentClick, true)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [draftConnection, finishDraftConnection, hoveredHandle])

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
        const hoveredHandleElement = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest('[data-workflow-node-id][data-workflow-handle-kind]')
        const nextHoveredHandle =
          hoveredHandleElement instanceof HTMLElement
            ? {
                kind: hoveredHandleElement.dataset.workflowHandleKind as
                  | 'input'
                  | 'output',
                nodeId: hoveredHandleElement.dataset.workflowNodeId ?? '',
              }
            : null

        setHoveredHandle(
          nextHoveredHandle?.nodeId ? nextHoveredHandle : null,
        )

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
      const releasedOverHandle =
        target instanceof Element &&
        target.closest('[data-workflow-handle-kind]')

      if (releasedOverHandle || hoveredHandle) {
        finishDraftConnection(draftConnection, hoveredHandle)
        return
      }

      setDraftConnection(null)
      setHoveredHandle(null)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [draftConnection, hoveredHandle, finishDraftConnection])

  useEffect(() => {
    if (!saveMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSaveMessage(null)
    }, 2200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [saveMessage])

  useEffect(() => {
    if (!autoSaveDraft) {
      return
    }

    if (!workflowTemplateId) {
      const isMeaningfulDraft =
        nodes.length > 0 || workflowName.trim() !== DEFAULT_WORKFLOW_NAME

      if (!isMeaningfulDraft) {
        clearWorkflowDraft()
        lastStoredDraftSignatureRef.current = workflowSignature
        return
      }

      if (workflowSignature === lastStoredDraftSignatureRef.current) {
        return
      }

      const timeoutId = window.setTimeout(() => {
        storeWorkflowDraft({
          connections,
          nodes,
          workflowName,
        })
        lastStoredDraftSignatureRef.current = workflowSignature
        setSaveMessage('Draft cached')
      }, 450)

      return () => {
        window.clearTimeout(timeoutId)
      }
    }

    if (!hasUnsavedChanges) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void persistWorkflow('auto')
    }, 700)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    autoSaveDraft,
    connections,
    hasUnsavedChanges,
    nodes,
    persistWorkflow,
    workflowName,
    workflowSignature,
    workflowTemplateId,
  ])

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
        sourceId: item.key,
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

    event.preventDefault()

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
    startHandleKind: 'input' | 'output',
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const node = nodes.find((candidate) => candidate.id === nodeId)
    const canvasBounds = canvasRef.current?.getBoundingClientRect()
    if (!node || !canvasBounds) {
      return
    }

    const startAnchor =
      startHandleKind === 'input'
        ? getNodeInputAnchor(node)
        : getNodeOutputAnchor(node)

    setHoveredConnectionId(null)
    setHoveredHandle(null)
    setDraftConnection({
      color: nodeThemes[node.type].border,
      startHandleKind,
      startNodeId: nodeId,
      startX: startAnchor.x,
      startY: startAnchor.y,
      x: event.clientX - canvasBounds.left,
      y: event.clientY - canvasBounds.top,
    })
  }

  const handleConnectionDelete = (connectionId: string) => {
    setConnections((currentConnections) =>
      currentConnections.filter((connection) => connection.id !== connectionId),
    )
    setHoveredConnectionId((currentHoveredConnectionId) =>
      currentHoveredConnectionId === connectionId ? null : currentHoveredConnectionId,
    )
  }

  return (
    <div aria-label="Workflow Designer" className="flex h-full w-full flex-col bg-white">
      <header className="flex h-14 items-center justify-between gap-4 border-b border-black/8 bg-white px-4">
        <div className="min-w-0 flex-1">
          <input
            aria-label="Workflow name"
            className="w-full max-w-xl border-none bg-transparent text-[15px] font-semibold text-[#2f2237] outline-none placeholder:text-[#9a8aa2]"
            onChange={(event) => setWorkflowName(event.target.value)}
            placeholder={DEFAULT_WORKFLOW_NAME}
            value={workflowName}
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="min-w-[96px] text-right text-[11px] text-[#7c6b86]">
            {isWorkflowTemplateLoading ? (
              'Loading workflow...'
            ) : saveMessage ? (
              <span className="inline-flex items-center gap-1">
                <FontAwesomeIcon className="text-[10px]" icon={faCheck} />
                {saveMessage}
              </span>
            ) : workflowTemplateId ? (
              'Saved workflow'
            ) : (
              'New workflow'
            )}
          </div>

          <label className="flex items-center gap-2 text-[11px] font-medium text-[#5f4e67]">
            <span>Auto save</span>
            <button
              aria-label="Toggle auto save"
              aria-pressed={autoSaveDraft}
              className={[
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                autoSaveDraft ? 'bg-[#7445c7]' : 'bg-[#d9d1df]',
              ].join(' ')}
              onClick={() => setAutoSaveDraft((currentValue) => !currentValue)}
              type="button"
            >
              <span
                className={[
                  'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                  autoSaveDraft ? 'translate-x-5' : 'translate-x-1',
                ].join(' ')}
              />
            </button>
          </label>

          <button
            className="admin-button admin-button-primary min-w-[88px]"
            disabled={!hasWorkflowToSave || isSavingWorkflow}
            onClick={() => {
              void persistWorkflow('manual')
            }}
            type="button"
          >
            {isSavingWorkflow ? 'Saving...' : 'Save'}
          </button>
        </div>
      </header>

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
          {connectionLayouts.map((connectionLayout) => {
            return (
              <g key={connectionLayout.id} className="pointer-events-auto">
                <path
                  d={connectionLayout.path}
                  fill="none"
                  stroke={connectionLayout.color}
                  strokeLinecap="round"
                  strokeWidth="3"
                />
                <path
                  className="cursor-pointer"
                  d={connectionLayout.path}
                  fill="none"
                  onMouseEnter={() => setHoveredConnectionId(connectionLayout.id)}
                  onMouseLeave={(event) => {
                    const relatedTarget = event.relatedTarget
                    if (
                      relatedTarget instanceof Element &&
                      relatedTarget.closest(
                        `[data-connection-delete-id="${connectionLayout.id}"]`,
                      )
                    ) {
                      return
                    }

                    setHoveredConnectionId((currentHoveredConnectionId) =>
                      currentHoveredConnectionId === connectionLayout.id
                        ? null
                        : currentHoveredConnectionId,
                    )
                  }}
                  stroke="transparent"
                  strokeWidth="18"
                />
              </g>
            )
          })}

          {draftConnection ? (
            <path
              d={getConnectionGeometry(
                { x: draftConnection.startX, y: draftConnection.startY },
                { x: draftConnection.x, y: draftConnection.y },
              ).path}
              fill="none"
              stroke={draftConnection.color}
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

        {connectionLayouts.map((connectionLayout) =>
          hoveredConnectionId === connectionLayout.id ? (
            <button
              key={connectionLayout.id}
              className="absolute z-10 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-white shadow-[0_10px_24px_rgba(31,22,38,0.16)] transition-transform hover:scale-105"
              data-connection-delete-id={connectionLayout.id}
              onClick={() => handleConnectionDelete(connectionLayout.id)}
              onMouseEnter={() => setHoveredConnectionId(connectionLayout.id)}
              onMouseLeave={() =>
                setHoveredConnectionId((currentHoveredConnectionId) =>
                  currentHoveredConnectionId === connectionLayout.id
                    ? null
                    : currentHoveredConnectionId,
                )
              }
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              style={{
                borderColor: connectionLayout.color,
                color: connectionLayout.color,
                left: connectionLayout.midpoint.x,
                top: connectionLayout.midpoint.y,
              }}
              type="button"
            >
              <FontAwesomeIcon className="text-[12px]" icon={faTrashCan} />
            </button>
          ) : null,
        )}

        {nodes.map((node) => {
          const theme = nodeThemes[node.type]
          const hasIncomingConnection = connections.some(
            (connection) => connection.toNodeId === node.id,
          )
          const isHoveredInput =
            hoveredHandle?.nodeId === node.id && hoveredHandle.kind === 'input'
          const isHoveredOutput =
            hoveredHandle?.nodeId === node.id && hoveredHandle.kind === 'output'
          const isInvalidInputTarget =
            invalidDraftTarget?.nodeId === node.id &&
            invalidDraftTarget.kind === 'input'
          const isInvalidOutputTarget =
            invalidDraftTarget?.nodeId === node.id &&
            invalidDraftTarget.kind === 'output'

          return (
            <div
              key={node.id}
              className="absolute cursor-grab select-none rounded-2xl border bg-white shadow-[0_18px_40px_rgba(31,22,38,0.12)] active:cursor-grabbing"
              onPointerDown={(event) => handleNodePointerDown(event, node.id)}
              style={{
                backgroundColor: theme.fill,
                borderColor: theme.border,
                height: CANVAS_NODE_HEIGHT,
                left: node.x,
                top: node.y,
                userSelect: 'none',
                width: CANVAS_NODE_WIDTH,
              }}
            >
              {node.type !== 'trigger' ? (
                <button
                  aria-label={`Connect into ${node.label}`}
                  className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 transition-all hover:scale-110 hover:bg-current"
                  data-workflow-handle-kind="input"
                  data-workflow-node-id={node.id}
                  onPointerDown={(event) =>
                    handleConnectionStart(event, node.id, 'input')
                  }
                  style={{
                    backgroundColor: isHoveredInput
                      ? isInvalidInputTarget
                        ? '#dc2626'
                        : theme.border
                      : hasIncomingConnection
                        ? 'transparent'
                      : '#ffffff',
                    borderColor: isInvalidInputTarget ? '#dc2626' : theme.border,
                    color: isInvalidInputTarget ? '#dc2626' : theme.border,
                    top: CANVAS_NODE_HANDLE_Y + CANVAS_NODE_HANDLE_OFFSET_Y,
                    transform: isHoveredInput
                      ? 'translateY(-50%) scale(1.1)'
                      : 'translateY(-50%)',
                  }}
                  type="button"
                />
              ) : null}

              <button
                aria-label={`Connect from ${node.label}`}
                className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 bg-white transition-all hover:scale-110 hover:bg-current"
                data-workflow-handle-kind="output"
                data-workflow-node-id={node.id}
                onPointerDown={(event) =>
                  handleConnectionStart(event, node.id, 'output')
                }
                style={{
                  backgroundColor: isHoveredOutput
                    ? isInvalidOutputTarget
                      ? '#dc2626'
                      : theme.border
                    : '#ffffff',
                  borderColor: isInvalidOutputTarget ? '#dc2626' : theme.border,
                  color: isInvalidOutputTarget ? '#dc2626' : theme.border,
                  top: CANVAS_NODE_HANDLE_Y + CANVAS_NODE_HANDLE_OFFSET_Y,
                  transform: isHoveredOutput
                    ? 'translateY(-50%) scale(1.1)'
                    : 'translateY(-50%)',
                }}
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
