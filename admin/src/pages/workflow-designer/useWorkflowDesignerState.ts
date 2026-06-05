import { useEffect, useMemo, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import {
  faBolt,
  faPlus,
  faRobot,
  faScrewdriverWrench,
} from '@fortawesome/free-solid-svg-icons'
import { useAgents } from '../../facades/agents/hooks'
import { useTools } from '../../facades/tools/hooks'
import {
  CANVAS_NODE_INSERT_OFFSET,
  CANVAS_NODE_INSERT_STEPS,
  DEFAULT_WORKFLOW_NAME,
  WORKFLOW_TOOL_NODE_IDS,
  WORKFLOW_TRIGGER_TYPE_LABELS,
} from '../../lib/workflow-designer/constants'
import { getCanvasInsertionPoint } from '../../lib/workflow-designer/geometry'
import { formatJson, readJsonObject } from '../../lib/workflow-designer/json'
import {
  getWorkflowNodeInitialConfig,
  getWorkflowNodeLabel,
  getWorkflowNodeMeta,
} from '../../lib/workflow-designer/node-sources'
import type {
  ToolbarAction,
  ToolbarMenuItem,
  WorkflowCanvasNode,
  WorkflowConnection,
} from '../../lib/workflow-designer/types'

type UseWorkflowDesignerStateInput = {
  canvasRef: RefObject<HTMLDivElement | null>
  returnTo: string
  nextInsertOffsetRef: MutableRefObject<number>
}

export const useWorkflowDesignerState = ({
  canvasRef,
  returnTo,
  nextInsertOffsetRef,
}: UseWorkflowDesignerStateInput) => {
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()

  const [connections, setConnections] = useState<WorkflowConnection[]>([])
  const [nodes, setNodes] = useState<WorkflowCanvasNode[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedNodeConfigDraft, setSelectedNodeConfigDraft] = useState('{}')
  const [selectedNodeConfigError, setSelectedNodeConfigError] = useState<string | null>(null)
  const [workflowName, setWorkflowName] = useState(DEFAULT_WORKFLOW_NAME)

  const topLevelAgentSources = useMemo(
    () =>
      [...agents]
        .filter(
          (agent) =>
            !agent.parentAgentId && agent.agentKind !== 'personal_assistant',
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((agent) => ({
          config: getWorkflowNodeInitialConfig('agent', agent),
          label: getWorkflowNodeLabel('agent', agent),
          meta: getWorkflowNodeMeta('agent', agent),
          nodeType: 'agent' as const,
          sourceId: agent.id,
        })),
    [agents],
  )

  const triggerNodeSources = useMemo(
    () =>
      Object.entries(WORKFLOW_TRIGGER_TYPE_LABELS).map(([triggerType, label]) => ({
          config: getWorkflowNodeInitialConfig('trigger', {
            type: triggerType,
          }),
          label,
          meta: getWorkflowNodeMeta('trigger', {
            type: triggerType,
          }),
          nodeType: 'trigger' as const,
          sourceId: triggerType,
        })),
    [],
  )

  const toolNodeSources = useMemo(
    () =>
      [...tools]
        .filter((tool) => WORKFLOW_TOOL_NODE_IDS.has(tool.id))
        .sort((left, right) => left.label.localeCompare(right.label))
        .map((tool) => ({
          config: getWorkflowNodeInitialConfig('tool', tool),
          label: getWorkflowNodeLabel('tool', tool),
          meta: getWorkflowNodeMeta('tool', tool),
          nodeType: 'tool' as const,
          sourceId: tool.id,
        })),
    [tools],
  )

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId],
  )

  useEffect(() => {
    if (!selectedNode) {
      setSelectedNodeConfigDraft('{}')
      setSelectedNodeConfigError(null)
      return
    }

    setSelectedNodeConfigDraft(formatJson(selectedNode.config))
    setSelectedNodeConfigError(null)
  }, [selectedNode])

  useEffect(() => {
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(nodes[0]?.id ?? null)
    }
  }, [nodes, selectedNodeId])

  const selectedNodeSource = useMemo(() => {
    if (!selectedNode) {
      return undefined
    }

    const sources =
      selectedNode.type === 'agent'
        ? topLevelAgentSources
        : selectedNode.type === 'tool'
          ? toolNodeSources
          : triggerNodeSources

    return sources.find((source) => source.sourceId === selectedNode.sourceId)
  }, [selectedNode, topLevelAgentSources, toolNodeSources, triggerNodeSources])

  const selectedNodeSourceOptions = useMemo(() => {
    if (!selectedNode) {
      return []
    }

    return selectedNode.type === 'agent'
      ? topLevelAgentSources
      : selectedNode.type === 'tool'
        ? toolNodeSources
        : triggerNodeSources
  }, [selectedNode, topLevelAgentSources, toolNodeSources, triggerNodeSources])

  const toolbarActions = useMemo<ToolbarAction[]>(() => {
    return [
      {
        createItem: {
          icon: faPlus,
          key: 'new-trigger',
          label: 'New trigger',
        },
        emptyLabel: 'No triggers yet',
        icon: faBolt,
        items: triggerNodeSources.map((source) => ({
          icon: faBolt,
          key: source.sourceId,
          label: source.label,
          meta: source.meta,
          nodeType: source.nodeType,
        })),
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
        items: toolNodeSources.map((source) => ({
          icon: faScrewdriverWrench,
          key: source.sourceId,
          label: source.label,
          meta: source.meta,
          nodeType: source.nodeType,
        })),
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
        items: topLevelAgentSources.map((source) => ({
          icon: faRobot,
          key: source.sourceId,
          label: source.label,
          meta: source.meta,
          nodeType: source.nodeType,
        })),
        key: 'agents',
        label: 'Agents',
        sectionLabel: 'Top-level agents',
      },
    ]
  }, [returnTo, topLevelAgentSources, toolNodeSources, triggerNodeSources])

  const addNodeFromItem = (item: ToolbarMenuItem) => {
    if (!item.nodeType) {
      return
    }

    const nodeType = item.nodeType
    const source =
      nodeType === 'agent'
        ? topLevelAgentSources.find((entry) => entry.sourceId === item.key)
        : nodeType === 'tool'
          ? toolNodeSources.find((entry) => entry.sourceId === item.key)
          : triggerNodeSources.find((entry) => entry.sourceId === item.key)
    const offset = nextInsertOffsetRef.current
    nextInsertOffsetRef.current =
      (nextInsertOffsetRef.current + CANVAS_NODE_INSERT_OFFSET) %
      (CANVAS_NODE_INSERT_OFFSET * CANVAS_NODE_INSERT_STEPS)

    const insertionPoint = getCanvasInsertionPoint(canvasRef.current, offset)
    const nodeId = crypto.randomUUID()

    setNodes((currentNodes) => [
      ...currentNodes,
      {
        id: nodeId,
        config: source?.config ?? {},
        label: source?.label ?? item.label,
        meta: source?.meta ?? item.meta,
        sourceId: item.key,
        type: nodeType,
        x: insertionPoint.x,
        y: insertionPoint.y,
      },
    ])
    setSelectedNodeId(nodeId)
  }

  const handleSelectedNodeLabelChange = (value: string) => {
    if (!selectedNodeId) {
      return
    }

    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selectedNodeId ? { ...node, label: value } : node,
      ),
    )
  }

  const handleSelectedNodeSourceChange = (sourceId: string) => {
    if (!selectedNode) {
      return
    }

    const sources =
      selectedNode.type === 'agent'
        ? topLevelAgentSources
        : selectedNode.type === 'tool'
          ? toolNodeSources
          : triggerNodeSources
    const nextSource = sources.find((source) => source.sourceId === sourceId)
    if (!nextSource) {
      return
    }

    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selectedNode.id
          ? {
              ...node,
              config: nextSource.config,
              label: nextSource.label,
              meta: nextSource.meta,
              sourceId: nextSource.sourceId,
            }
          : node,
      ),
    )
    setSelectedNodeConfigDraft(formatJson(nextSource.config))
    setSelectedNodeConfigError(null)
  }

  const handleSelectedNodeConfigChange = (value: string) => {
    setSelectedNodeConfigDraft(value)
    const parsed = readJsonObject(value)
    if (parsed === null) {
      setSelectedNodeConfigError('Config must be valid JSON.')
      return
    }

    setSelectedNodeConfigError(null)
    if (!selectedNode) {
      return
    }

    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === selectedNode.id ? { ...node, config: parsed } : node,
      ),
    )
  }

  return {
    connections,
    setConnections,
    nodes,
    setNodes,
    selectedNodeId,
    setSelectedNodeId,
    selectedNode,
    selectedNodeConfigDraft,
    setSelectedNodeConfigDraft,
    selectedNodeConfigError,
    setSelectedNodeConfigError,
    workflowName,
    setWorkflowName,
    topLevelAgentSources,
    triggerNodeSources,
    toolNodeSources,
    selectedNodeSource,
    selectedNodeSourceOptions,
    toolbarActions,
    addNodeFromItem,
    handleSelectedNodeLabelChange,
    handleSelectedNodeSourceChange,
    handleSelectedNodeConfigChange,
  }
}
