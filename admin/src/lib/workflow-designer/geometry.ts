import {
  CANVAS_NODE_HANDLE_Y,
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_PADDING,
} from './constants'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowConnectionCandidate,
  WorkflowDraftConnection,
  WorkflowHoveredHandle,
} from './types'

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

export const getNodeInputAnchor = (node: WorkflowCanvasNode) => ({
  x: node.x,
  y: node.y + CANVAS_NODE_HANDLE_Y,
})

export const getNodeOutputAnchor = (node: WorkflowCanvasNode) => ({
  x: node.x + CANVAS_NODE_WIDTH,
  y: node.y + CANVAS_NODE_HANDLE_Y,
})

export const getConnectionGeometry = (
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

export const getOppositeHandleKind = (handleKind: 'input' | 'output') =>
  handleKind === 'input' ? 'output' : 'input'

export const getDraftConnectionCandidate = (
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

// W11: until graph v2 (Stage 2) the runtime executes exactly one connected
// linear chain, so the canvas must refuse to draw what it cannot execute —
// cycles, forks (multiple outgoing), and merges (multiple incoming) are
// rejected here rather than silently linearized away in serialization.ts.
const connectionWouldCreateCycle = (
  candidateConnection: WorkflowConnectionCandidate,
  connections: WorkflowConnection[],
): boolean => {
  const outgoingByNodeId = new Map<string, string[]>()
  for (const connection of connections) {
    const list = outgoingByNodeId.get(connection.fromNodeId) ?? []
    list.push(connection.toNodeId)
    outgoingByNodeId.set(connection.fromNodeId, list)
  }

  // Reachable(from candidate.toNodeId) must not contain candidate.fromNodeId.
  const visited = new Set<string>()
  const stack = [candidateConnection.toNodeId]
  while (stack.length > 0) {
    const nodeId = stack.pop()!
    if (nodeId === candidateConnection.fromNodeId) {
      return true
    }
    if (visited.has(nodeId)) {
      continue
    }
    visited.add(nodeId)
    for (const next of outgoingByNodeId.get(nodeId) ?? []) {
      stack.push(next)
    }
  }
  return false
}

export const isInvalidWorkflowConnection = (
  candidateConnection: WorkflowConnectionCandidate,
  connections: WorkflowConnection[],
) =>
  candidateConnection.fromNodeId === candidateConnection.toNodeId ||
  connections.some(
    (connection) =>
      connection.fromNodeId === candidateConnection.fromNodeId &&
      connection.toNodeId === candidateConnection.toNodeId,
  ) ||
  connections.some(
    (connection) => connection.fromNodeId === candidateConnection.fromNodeId,
  ) ||
  connections.some(
    (connection) => connection.toNodeId === candidateConnection.toNodeId,
  ) ||
  connectionWouldCreateCycle(candidateConnection, connections)

export const getCanvasInsertionPoint = (canvasElement: HTMLDivElement | null, offset: number) => {
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
