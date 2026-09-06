import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Dispatch,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react'
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
  CANVAS_PADDING,
  nodeThemes,
} from '../../lib/workflow-designer/constants'
import {
  clamp,
  getWorkflowConnectionLayouts,
  getDraftConnectionCandidate,
  getNodeInputAnchor,
  getNodeOutputAnchor,
  isInvalidWorkflowConnection,
} from '../../lib/workflow-designer/geometry'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowConnectionLayout,
  WorkflowDraftConnection,
  WorkflowHoveredHandle,
} from '../../lib/workflow-designer/types'

type UseWorkflowCanvasInteractionsInput = {
  canvasRef: MutableRefObject<HTMLDivElement | null>
  connections: WorkflowConnection[]
  setConnections: Dispatch<SetStateAction<WorkflowConnection[]>>
  nodes: WorkflowCanvasNode[]
  setNodes: Dispatch<SetStateAction<WorkflowCanvasNode[]>>
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>
}

export const useWorkflowCanvasInteractions = ({
  canvasRef,
  connections,
  setConnections,
  nodes,
  setNodes,
  setSelectedNodeId,
}: UseWorkflowCanvasInteractionsInput) => {
  const dragStateRef = useRef<{
    offsetX: number
    offsetY: number
    nodeId: string
    pointerId: number
  } | null>(null)

  const [draftConnection, setDraftConnection] = useState<WorkflowDraftConnection | null>(null)
  const [hoveredHandle, setHoveredHandle] = useState<WorkflowHoveredHandle | null>(null)
  const [hoveredConnectionId, setHoveredConnectionId] = useState<string | null>(null)
  const [isDraggingNode, setIsDraggingNode] = useState(false)

  const connectionLayouts = useMemo<WorkflowConnectionLayout[]>(
    () => getWorkflowConnectionLayouts(nodes, connections),
    [connections, nodes],
  )

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
    [connections, setConnections],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDraftConnection(null)
        setHoveredHandle(null)
        setHoveredConnectionId(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
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
    const stopNodeDrag = (pointerId?: number) => {
      const dragState = dragStateRef.current
      if (!dragState) {
        return
      }

      if (typeof pointerId === 'number' && dragState.pointerId !== pointerId) {
        return
      }

      dragStateRef.current = null
      setIsDraggingNode(false)
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current

      if (
        dragState &&
        dragState.pointerId === event.pointerId &&
        canvasRef.current
      ) {
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
            node.id === dragState.nodeId
              ? {
                  ...node,
                  x: clamp(
                    event.clientX - canvasBounds.left - dragState.offsetX,
                    CANVAS_PADDING,
                    maxX,
                  ),
                  y: clamp(
                    event.clientY - canvasBounds.top - dragState.offsetY,
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
      stopNodeDrag(event.pointerId)

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

    const handlePointerCancel = (event: PointerEvent) => {
      stopNodeDrag(event.pointerId)
    }

    const handleWindowBlur = () => {
      stopNodeDrag()
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [canvasRef, draftConnection, hoveredHandle, finishDraftConnection, setNodes])

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

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    setSelectedNodeId(nodeId)
    setIsDraggingNode(true)

    const canvasBounds = canvasRef.current.getBoundingClientRect()
    dragStateRef.current = {
      nodeId,
      offsetX: event.clientX - canvasBounds.left - node.x,
      offsetY: event.clientY - canvasBounds.top - node.y,
      pointerId: event.pointerId,
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

  return {
    dragStateRef,
    draftConnection,
    hoveredHandle,
    hoveredConnectionId,
    setHoveredConnectionId,
    isDraggingNode,
    connectionLayouts,
    invalidDraftTarget,
    handleNodePointerDown,
    handleConnectionStart,
    handleConnectionDelete,
  }
}
