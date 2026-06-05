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

export const isInvalidWorkflowConnection = (
  candidateConnection: WorkflowConnectionCandidate,
  connections: WorkflowConnection[],
) =>
  candidateConnection.fromNodeId === candidateConnection.toNodeId ||
  connections.some(
    (connection) =>
      connection.fromNodeId === candidateConnection.fromNodeId &&
      connection.toNodeId === candidateConnection.toNodeId,
  )

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
