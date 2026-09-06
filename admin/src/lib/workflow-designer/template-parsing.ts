import {
  CANVAS_NODE_INSERT_OFFSET,
  CANVAS_NODE_INSERT_STEPS,
  WORKFLOW_TRIGGER_TYPE_LABELS,
} from './constants'
import { getCanvasInsertionPoint } from './geometry'
import { isRecord, readRecord } from './json'
import { getWorkflowCanvasNodeType } from './node-sources'
import { readSerializedNode, readWorkflowStepConfig } from './canvas-structure'
import type { WorkflowPreservedStep } from './graph-serialization'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
  WorkflowDesignerDraft,
  WorkflowTriggerTemplateNode,
} from './types'

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

export type ParsedWorkflowTemplate = Pick<
  WorkflowDesignerDraft,
  'connections' | 'nodes'
> & {
  // The graph's original step order as loaded, for `buildWorkflowGraph` to
  // keep preserved steps (and loaded-but-unconnected nodes) at their original
  // positions on save (W10). An explicit field on the parse result rather
  // than module state the save path reads back out of thin air.
  loadedStepOrder: string[]
  preservedSteps: WorkflowPreservedStep[]
}

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
): ParsedWorkflowTemplate => {
  const loadedStepOrder = graph.steps.map((step) => step.id)

  // W10: steps the canvas cannot render are kept verbatim and passed back to
  // buildWorkflowGraph, so a load → save cycle never drops them.
  const preservedSteps = graph.steps
    .filter((step) => getWorkflowCanvasNodeType(step.type) === null)
    .map((step) => ({
      id: step.id,
      input: step.input,
      title: step.title,
      type: step.type,
    }))

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
        rawStepInput: (() => {
          if (!isRecord(step.input)) {
            return undefined
          }
          const rest = Object.fromEntries(
            Object.entries(step.input).filter(([key]) => key !== 'workflowDesigner'),
          )
          return Object.keys(rest).length > 0 ? rest : undefined
        })(),
        sourceId:
          serializedNode.sourceId
          ?? (stepType === 'agent'
            ? String(readWorkflowStepConfig(step).agentId ?? step.id)
            : stepType === 'tool'
              ? String(readWorkflowStepConfig(step).toolName ?? step.id)
              : stepType === 'transform'
                ? 'transform'
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

  // Loaded steps keep the graph's implicit sequence; the canvas chain is
  // rebuilt only when the author actually draws an edge.
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
    loadedStepOrder,
    nodes: allNodes,
    preservedSteps,
  }
}
