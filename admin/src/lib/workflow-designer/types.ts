import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

export type WorkflowCanvasNodeType = 'agent' | 'tool' | 'transform' | 'trigger'

export type ToolbarMenuItem = {
  icon: IconDefinition
  key: string
  label: string
  meta?: string
  nodeType?: WorkflowCanvasNodeType
  state?: Record<string, unknown>
  to?: string
}

export type ToolbarAction = {
  createItem?: ToolbarMenuItem
  emptyLabel: string
  icon: IconDefinition
  items: ToolbarMenuItem[]
  key: string
  label: string
  sectionLabel: string
}

export type WorkflowCanvasNode = {
  id: string
  label: string
  config: Record<string, unknown>
  meta?: string
  // W10: verbatim step input as loaded; the canvas `config` is the stripped
  // editing view, and saving starts from this so keys the inspector doesn't
  // edit survive the round trip.
  rawStepInput?: Record<string, unknown>
  sourceId: string
  type: WorkflowCanvasNodeType
  x: number
  y: number
}

export type WorkflowConnection = {
  fromNodeId: string
  id: string
  toNodeId: string
}

export type WorkflowConnectionCandidate = {
  fromNodeId: string
  toNodeId: string
}

export type WorkflowConnectionLayout = {
  color: string
  id: string
  midpoint: { x: number; y: number }
  path: string
}

export type WorkflowDraftConnection = {
  color: string
  startHandleKind: 'input' | 'output'
  startNodeId: string
  startX: number
  startY: number
  x: number
  y: number
}

export type WorkflowHoveredHandle = {
  kind: 'input' | 'output'
  nodeId: string
}

export type WorkflowDesignerDraft = {
  connections: WorkflowConnection[]
  nodes: WorkflowCanvasNode[]
  workflowName: string
}

export type WorkflowDesignerSerializedNode = {
  config?: Record<string, unknown>
  meta?: string
  outgoingNodeIds: string[]
  position?: {
    x?: number
    y?: number
  }
  sourceId?: string
}

export type WorkflowDesignerLocationState = {
  returnTo?: string
  returnToState?: unknown
}

export type WorkflowTriggerTemplateNode = {
  config: Record<string, unknown>
  description?: string
  enabled?: boolean
  id: string
  meta?: string
  name?: string
  nextRunAt?: string
  position?: {
    x?: number
    y?: number
  }
  sourceId: string
  targetNodeIds: string[]
  title?: string
  type: string
}
