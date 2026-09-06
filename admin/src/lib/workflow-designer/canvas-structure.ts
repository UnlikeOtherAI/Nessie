import { isRecord, readRecord } from './json'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowDesignerSerializedNode,
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

// W11: the runtime executes exactly one connected chain, so "the linear
// order" is only defined when the canvas IS one chain. Orphans, merges,
// forks and cycles produce a structure error instead of being silently
// appended to the end — where they would still execute.
export type WorkflowCanvasStructure =
  | { kind: 'empty' }
  | { kind: 'chain'; orderedNodes: WorkflowCanvasNode[] }
  | { kind: 'invalid'; error: string }

export const analyzeWorkflowCanvasStructure = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
): WorkflowCanvasStructure => {
  if (nodes.length === 0) {
    return { kind: 'empty' }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const incomingCounts = new Map(nodes.map((node) => [node.id, 0]))
  const outgoingNodeIds = new Map<string, string[]>()

  for (const connection of connections) {
    if (!nodeById.has(connection.fromNodeId) || !nodeById.has(connection.toNodeId)) {
      continue
    }
    incomingCounts.set(
      connection.toNodeId,
      (incomingCounts.get(connection.toNodeId) ?? 0) + 1,
    )
    outgoingNodeIds.set(connection.fromNodeId, [
      ...(outgoingNodeIds.get(connection.fromNodeId) ?? []),
      connection.toNodeId,
    ])
  }

  for (const [nodeId, count] of incomingCounts) {
    if (count > 1) {
      return {
        kind: 'invalid',
        error: `"${nodeById.get(nodeId)?.label ?? nodeId}" has more than one incoming connection — the runner cannot merge branches.`,
      }
    }
  }
  for (const [nodeId, targets] of outgoingNodeIds) {
    if (targets.length > 1) {
      return {
        kind: 'invalid',
        error: `"${nodeById.get(nodeId)?.label ?? nodeId}" has more than one outgoing connection — the runner cannot fan out.`,
      }
    }
  }

  const startNodes = nodes.filter((node) => (incomingCounts.get(node.id) ?? 0) === 0)
  if (startNodes.length !== 1) {
    return {
      kind: 'invalid',
      error:
        startNodes.length === 0
          ? 'The canvas has a cycle — connect the steps into a single forward chain.'
          : 'Every step must connect into one chain — remove or link the disconnected nodes.',
    }
  }

  const orderedNodes: WorkflowCanvasNode[] = []
  const visited = new Set<string>()
  let current: WorkflowCanvasNode | undefined = startNodes[0]
  while (current) {
    if (visited.has(current.id)) {
      return {
        kind: 'invalid',
        error: 'The canvas has a cycle — connect the steps into a single forward chain.',
      }
    }
    visited.add(current.id)
    orderedNodes.push(current)
    const nextId = outgoingNodeIds.get(current.id)?.[0]
    current = nextId ? nodeById.get(nextId) : undefined
  }

  if (orderedNodes.length !== nodes.length) {
    return {
      kind: 'invalid',
      error: 'Every step must connect into one chain — remove or link the disconnected nodes.',
    }
  }

  return { kind: 'chain', orderedNodes }
}

// Linear order when the canvas is exactly one chain; otherwise the canvas
// order (callers rendering upstream-step pickers degrade, never invent).
export const getLinearWorkflowNodes = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) => {
  const structure = analyzeWorkflowCanvasStructure(nodes, connections)
  return structure.kind === 'chain' ? structure.orderedNodes : nodes
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
