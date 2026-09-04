import { useMemo, useRef } from 'react'

import type { WorkflowTemplateRecord } from '../../../lib/api-client'
import {
  CANVAS_NODE_HEIGHT,
  CANVAS_NODE_WIDTH,
} from '../../../lib/workflow-designer/constants'
import { getWorkflowConnectionLayouts } from '../../../lib/workflow-designer/geometry'
import { parseWorkflowTemplate } from '../../../lib/workflow-designer/serialization'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
} from '../../../lib/workflow-designer/types'
import { WorkflowCanvas } from '../workflow-designer/WorkflowCanvas'

const PREVIEW_GAP_X = 42
const PREVIEW_GAP_Y = 36
const PREVIEW_PADDING = 28
const PREVIEW_COLUMNS = 3

export const buildWorkflowPreviewGraph = (template: WorkflowTemplateRecord): {
  connections: WorkflowConnection[]
  height: number
  nodes: WorkflowCanvasNode[]
  width: number
} => {
  const parsed = parseWorkflowTemplate(template.graph, template.triggers, null)
  const parsedById = new Map(parsed.nodes.map((node) => [node.id, node]))
  // The editable v1 canvas intentionally preserves executors it cannot edit
  // (for example message_send). A preview must still show every executable
  // step, especially a graph an agent has just authored.
  const graphNodes = template.graph.steps.map((step) =>
    parsedById.get(step.id) ?? {
      config: step.input ?? {},
      id: step.id,
      label: step.title?.trim() || step.type.replace(/_/g, ' '),
      meta: step.type,
      sourceId: step.type,
      type: step.type === 'agent_task' ? 'agent' : step.type === 'transform' ? 'transform' : 'tool',
      x: 0,
      y: 0,
    } satisfies WorkflowCanvasNode,
  )
  const triggerNodes = parsed.nodes.filter((node) => node.type === 'trigger')
  const nodes = [...graphNodes, ...triggerNodes].map((node, index) => ({
    ...node,
    x: PREVIEW_PADDING + (index % PREVIEW_COLUMNS) * (CANVAS_NODE_WIDTH + PREVIEW_GAP_X),
    y: PREVIEW_PADDING + Math.floor(index / PREVIEW_COLUMNS) * (CANVAS_NODE_HEIGHT + PREVIEW_GAP_Y),
  }))
  // The runner executes a graph as the saved sequence. Designer-authored
  // edges carry their layout; agent-authored graphs have no canvas-only edge
  // metadata, so the preview supplies that single executable chain.
  const graphNodeIds = new Set(nodes.map((node) => node.id))
  const designerConnections = template.graph.steps.flatMap((step) => {
    const input = step.input?.['workflowDesigner']
    const outgoing = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as { outgoingNodeIds?: unknown }).outgoingNodeIds
      : undefined
    return Array.isArray(outgoing)
      ? outgoing.flatMap((toNodeId) =>
          typeof toNodeId === 'string' && graphNodeIds.has(toNodeId)
            ? [{ fromNodeId: step.id, id: `preview-${step.id}-${toNodeId}`, toNodeId }]
            : [])
      : []
  })
  const connections = designerConnections.length > 0
    ? designerConnections
    : nodes.slice(1).map((node, index) => ({
        fromNodeId: nodes[index]!.id,
        id: `preview-${nodes[index]!.id}-${node.id}`,
        toNodeId: node.id,
      }))
  const rows = Math.max(1, Math.ceil(nodes.length / PREVIEW_COLUMNS))
  return {
    connections,
    height: PREVIEW_PADDING * 2 + rows * CANVAS_NODE_HEIGHT + (rows - 1) * PREVIEW_GAP_Y,
    nodes,
    width: PREVIEW_PADDING * 2
      + Math.min(Math.max(nodes.length, 1), PREVIEW_COLUMNS) * CANVAS_NODE_WIDTH
      + Math.max(0, Math.min(nodes.length, PREVIEW_COLUMNS) - 1) * PREVIEW_GAP_X,
  }
}

/** The same canvas used by the editor, rendered without draggable controls. */
export const WorkflowTemplatePreviewCanvas = ({
  compact = false,
  template,
}: {
  compact?: boolean
  template: WorkflowTemplateRecord
}) => {
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const graph = useMemo(() => buildWorkflowPreviewGraph(template), [template])
  const connectionLayouts = useMemo(
    () => getWorkflowConnectionLayouts(graph.nodes, graph.connections),
    [graph],
  )
  const scale = compact ? Math.min(0.56, 480 / graph.width) : 1
  const dragStateRef = useRef<null>(null)

  return (
    <div
      aria-label={`${template.name} workflow diagram`}
      className={compact ? 'h-44 overflow-hidden rounded-[var(--radius-md)]' : 'overflow-auto'}
    >
      <div
        style={{
          height: graph.height * scale,
          width: graph.width * scale,
        }}
      >
        <WorkflowCanvas
          canvasRef={canvasRef}
          className={compact ? 'origin-top-left' : undefined}
          connections={graph.connections}
          connectionLayouts={connectionLayouts}
          dragStateRef={dragStateRef}
          draftConnection={null}
          hoveredConnectionId={null}
          hoveredHandle={null}
          invalidDraftTarget={null}
          nodes={graph.nodes}
          readOnly
          selectedNodeId={null}
          setHoveredConnectionId={() => undefined}
          stepRunsByNodeId={new Map()}
          style={{
            height: graph.height,
            transform: compact ? `scale(${scale})` : undefined,
            width: graph.width,
          }}
          onClearSelection={() => undefined}
          onConnectionDelete={() => undefined}
          onConnectionStart={() => undefined}
          onNodePointerDown={() => undefined}
        />
      </div>
    </div>
  )
}
