import {
  CANVAS_NODE_INSERT_OFFSET,
  CANVAS_NODE_INSERT_STEPS,
  WORKFLOW_TRIGGER_TYPE_LABELS,
} from './constants'
import { getCanvasInsertionPoint } from './geometry'
import { isRecord, readRecord } from './json'
import {
  getWorkflowCanvasNodeType,
  getWorkflowRuntimeStepType,
} from './node-sources'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowDesignerDraft,
  WorkflowDesignerSerializedNode,
  WorkflowTriggerTemplateNode,
} from './types'

export const readSerializedNode = (value: unknown): WorkflowDesignerSerializedNode => {
  if (!isRecord(value)) {
    return {
      outgoingNodeIds: [],
    }
  }

  const positionValue = isRecord(value.position) ? value.position : undefined
  return {
    config: isRecord(value.config) ? value.config : undefined,
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

export const getLinearWorkflowNodes = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) => {
  if (nodes.length === 0) {
    return []
  }

  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const incomingCounts = new Map(nodes.map((node) => [node.id, 0]))
  const outgoingNodeIdsByNodeId = new Map<string, string[]>()

  for (const connection of connections) {
    if (!nodeById.has(connection.fromNodeId) || !nodeById.has(connection.toNodeId)) {
      continue
    }

    incomingCounts.set(
      connection.toNodeId,
      (incomingCounts.get(connection.toNodeId) ?? 0) + 1,
    )

    const outgoingNodeIds = outgoingNodeIdsByNodeId.get(connection.fromNodeId) ?? []
    outgoingNodeIdsByNodeId.set(connection.fromNodeId, [
      ...outgoingNodeIds,
      connection.toNodeId,
    ])
  }

  const orderedNodes: WorkflowCanvasNode[] = []
  const visitedNodeIds = new Set<string>()

  const appendChain = (startNode: WorkflowCanvasNode) => {
    let currentNode: WorkflowCanvasNode | undefined = startNode

    while (currentNode && !visitedNodeIds.has(currentNode.id)) {
      orderedNodes.push(currentNode)
      visitedNodeIds.add(currentNode.id)

      const nextNodeCandidates = (outgoingNodeIdsByNodeId.get(currentNode.id) ?? [])
        .filter((nodeId) => nodeById.has(nodeId) && !visitedNodeIds.has(nodeId))
        .sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0))
      const nextNodeId: string | undefined = nextNodeCandidates[0]

      currentNode = nextNodeId ? nodeById.get(nextNodeId) : undefined
    }
  }

  const startNodes = nodes
    .filter((node) => (incomingCounts.get(node.id) ?? 0) === 0)
    .sort((left, right) => (nodeOrder.get(left.id) ?? 0) - (nodeOrder.get(right.id) ?? 0))

  for (const node of startNodes) {
    appendChain(node)
  }

  for (const node of nodes) {
    if (!visitedNodeIds.has(node.id)) {
      appendChain(node)
    }
  }

  return orderedNodes
}

export const buildExecutableNodeConfig = (
  node: WorkflowCanvasNode,
): Record<string, unknown> => {
  const config = readRecord(node.config)

  if (node.type === 'agent') {
    return {
      ...config,
      agentId:
        typeof config.agentId === 'string' && config.agentId.trim()
          ? config.agentId
          : node.sourceId,
    }
  }

  if (node.type === 'tool') {
    return {
      ...config,
      toolName:
        typeof config.toolName === 'string' && config.toolName.trim()
          ? config.toolName
          : node.sourceId,
    }
  }

  return {
    ...config,
    type:
      typeof config.type === 'string' && config.type.trim()
        ? config.type
        : node.sourceId,
  }
}

export const readWorkflowStepConfig = (step: {
  input?: Record<string, unknown>
}): Record<string, unknown> => {
  const stepInput = readRecord(step.input)
  const runtimeConfig = Object.fromEntries(
    Object.entries(stepInput).filter(([key]) => key !== 'workflowDesigner'),
  )
  if (Object.keys(runtimeConfig).length > 0) {
    return runtimeConfig
  }

  const serializedNode = readSerializedNode(stepInput.workflowDesigner)
  return serializedNode.config ?? {}
}

export const readWorkflowTemplateTriggers = (
  value: unknown,
): WorkflowTriggerTemplateNode[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!isRecord(entry)) {
          return []
        }

        const type =
          typeof entry.type === 'string'
            ? entry.type
            : typeof entry.sourceId === 'string'
              ? entry.sourceId
              : typeof readRecord(entry.config).type === 'string'
                ? String(readRecord(entry.config).type)
                : undefined

        if (!type) {
          return []
        }

        return [
          {
            config: readRecord(entry.config),
            description:
              typeof entry.description === 'string' ? entry.description : undefined,
            enabled:
              typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
            id: typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
            meta: typeof entry.meta === 'string' ? entry.meta : undefined,
            name: typeof entry.name === 'string' ? entry.name : undefined,
            nextRunAt:
              typeof entry.nextRunAt === 'string' ? entry.nextRunAt : undefined,
            position: isRecord(entry.position)
              ? {
                  x:
                    typeof entry.position.x === 'number'
                      ? entry.position.x
                      : undefined,
                  y:
                    typeof entry.position.y === 'number'
                      ? entry.position.y
                      : undefined,
                }
              : undefined,
            sourceId:
              typeof entry.sourceId === 'string' ? entry.sourceId : type,
            targetNodeIds: Array.isArray(entry.targetNodeIds)
              ? entry.targetNodeIds.filter(
                  (nodeId): nodeId is string => typeof nodeId === 'string',
                )
              : [],
            title: typeof entry.title === 'string' ? entry.title : undefined,
            type,
          } satisfies WorkflowTriggerTemplateNode,
        ]
      })
    : []

export const buildWorkflowGraph = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) => ({
  steps: getLinearWorkflowNodes(nodes, connections)
    .filter((node) => node.type !== 'trigger')
    .map((node) => {
      const executableConfig = buildExecutableNodeConfig(node)
      return {
        id: node.id,
        input: {
          ...executableConfig,
          workflowDesigner: {
            config: executableConfig,
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
        type: getWorkflowRuntimeStepType(node.type),
      }
    }),
})

export const buildWorkflowTriggers = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) =>
  nodes
    .filter((node) => node.type === 'trigger')
    .map((node) => {
      const triggerConfig = buildExecutableNodeConfig(node)
      const {
        description,
        enabled,
        nextRunAt,
        type,
        ...config
      } = triggerConfig

      return {
        config,
        description:
          typeof description === 'string' ? description : undefined,
        enabled: enabled !== false,
        id: node.id,
        meta: node.meta,
        name: node.label,
        nextRunAt:
          typeof nextRunAt === 'string' ? nextRunAt : undefined,
        position: {
          x: Math.round(node.x),
          y: Math.round(node.y),
        },
        sourceId: node.sourceId,
        targetNodeIds: connections
          .filter((connection) => connection.fromNodeId === node.id)
          .map((connection) => connection.toNodeId),
        title: node.label,
        type:
          typeof type === 'string' && type.trim() ? type : node.sourceId,
      }
    })

export const parseWorkflowTemplate = (
  graph: {
    steps: Array<{
      id: string
      input?: Record<string, unknown>
      title?: string
      type: string
    }>
  },
  triggers: unknown,
  canvasElement: HTMLDivElement | null,
): Pick<WorkflowDesignerDraft, 'connections' | 'nodes'> => {
  const parsedNodes = graph.steps.flatMap((step, index) => {
    const stepType = getWorkflowCanvasNodeType(step.type)
    if (!stepType) {
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
        config: readWorkflowStepConfig(step),
        meta: serializedNode.meta,
        sourceId:
          serializedNode.sourceId
          ?? (stepType === 'agent'
            ? String(readWorkflowStepConfig(step).agentId ?? step.id)
            : stepType === 'tool'
              ? String(readWorkflowStepConfig(step).toolName ?? step.id)
              : step.id),
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

  const triggerNodes = readWorkflowTemplateTriggers(triggers).map((trigger, index) => {
    const fallbackPosition = getCanvasInsertionPoint(
      canvasElement,
      ((parsedNodes.length + index) % CANVAS_NODE_INSERT_STEPS) *
        CANVAS_NODE_INSERT_OFFSET,
    )

    return {
      id: trigger.id,
      label:
        trigger.title?.trim()
        || trigger.name?.trim()
        || WORKFLOW_TRIGGER_TYPE_LABELS[
          trigger.type as keyof typeof WORKFLOW_TRIGGER_TYPE_LABELS
        ]
        || 'Untitled trigger',
      config: {
        ...trigger.config,
        ...(trigger.description ? { description: trigger.description } : {}),
        ...(trigger.nextRunAt ? { nextRunAt: trigger.nextRunAt } : {}),
        ...(trigger.enabled !== undefined ? { enabled: trigger.enabled } : {}),
        type: trigger.type,
      },
      meta: trigger.meta ?? trigger.type,
      sourceId: trigger.sourceId,
      type: 'trigger' as const,
      x:
        typeof trigger.position?.x === 'number'
          ? trigger.position.x
          : fallbackPosition.x,
      y:
        typeof trigger.position?.y === 'number'
          ? trigger.position.y
          : fallbackPosition.y,
    }
  })

  const allNodes = [...parsedNodes, ...triggerNodes]

  const triggerConnections = readWorkflowTemplateTriggers(triggers).flatMap((trigger) =>
    trigger.targetNodeIds.flatMap((toNodeId) =>
      allNodes.some((candidate) => candidate.id === toNodeId)
        ? [
            {
              id: crypto.randomUUID(),
              fromNodeId: trigger.id,
              toNodeId,
            } satisfies WorkflowConnection,
          ]
        : [],
    ),
  )

  return {
    connections: [...parsedConnections, ...triggerConnections],
    nodes: allNodes,
  }
}
