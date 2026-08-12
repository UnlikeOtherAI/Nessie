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

export class WorkflowCanvasStructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowCanvasStructureError'
  }
}

export type WorkflowPreservedStep = {
  id: string
  input?: Record<string, unknown>
  title?: string
  type: string
}

export const buildWorkflowGraph = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
  preservedSteps: WorkflowPreservedStep[] = [],
) => {
  // W10: unknown/unrenderable steps never became canvas nodes; the caller
  // passes them in as `preservedSteps` and they are written back verbatim at
  // their original graph position. Steps that DID load onto the canvas must
  // form exactly one connected chain (W11) — saving an unexecutable shape
  // is an explicit error, not a silent linearization that would run steps
  // the author disconnected.
  const canvasNodeIds = new Set(nodes.map((node) => node.id))

  const executableNodes = nodes.filter((node) => node.type !== 'trigger')
  const canvasConnections = connections.filter(
    (connection) =>
      canvasNodeIds.has(connection.fromNodeId) &&
      canvasNodeIds.has(connection.toNodeId),
  )

  // New nodes (added this session, so absent from the loaded graph) must be
  // connected into the chain — an orphan created on the canvas is a structure
  // error, not a step that silently runs at the end. Loaded-but-unconnected
  // nodes keep the graph's original implicit sequence (the way the template
  // was authored, e.g. by the PA), so loading and re-saving a flat sequence
  // is not rejected as "disconnected".
  const disconnectedNewNode = executableNodes.find(
    (node) =>
      !currentLoadedStepOrderSet.has(node.id) &&
      !canvasConnections.some(
        (connection) =>
          connection.fromNodeId === node.id || connection.toNodeId === node.id,
      ) &&
      executableNodes.length > 1,
  )
  if (disconnectedNewNode) {
    throw new WorkflowCanvasStructureError(
      `"${disconnectedNewNode.label}" is not connected — link it into the chain or remove it.`,
    )
  }

  const structure = analyzeWorkflowCanvasStructure(executableNodes, canvasConnections)
  if (structure.kind === 'invalid') {
    const hasEdges = canvasConnections.length > 0
    const allLoaded =
      hasEdges === false &&
      executableNodes.every((node) => currentLoadedStepOrderSet.has(node.id))
    if (allLoaded) {
      // Fall through: original implicit sequence, handled by loadedCanvasIndex.
    } else {
      throw new WorkflowCanvasStructureError(structure.error)
    }
  }

  const orderedIndexByNodeId = new Map(
    (structure.kind === 'chain'
      ? structure.orderedNodes
      : [...executableNodes].sort(
          (left, right) => loadedCanvasIndex(left.id) - loadedCanvasIndex(right.id),
        )
    ).map((node, index) => [node.id, index]),
  )

  const steps = executableNodes
    .slice()
    .sort(
      (left, right) =>
        (orderedIndexByNodeId.get(left.id) ?? 0) - (orderedIndexByNodeId.get(right.id) ?? 0),
    )
    .map((node) => {
      const executableConfig = buildExecutableNodeConfig(node)
      // W10: keys the canvas inspector doesn't edit survive the round trip —
      // the input starts from the verbatim loaded step, not the stripped
      // canvas view of it.
      return {
        id: node.id,
        input: {
          ...node.rawStepInput,
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
    })

  // Splice preserved steps back at their ORIGINAL positions: a step the
  // designer cannot render (e.g. environment_launch) must not move. Walk the
  // loaded graph's original order, emitting the canvas version when the step
  // loaded or the verbatim copy when it did not; brand-new canvas steps
  // append in chain order.
  const preservedById = new Map(preservedSteps.map((step) => [step.id, step]))
  const loadedById = new Map(steps.map((step) => [step.id, step]))
  const originalOrder = currentLoadedStepOrder.filter(
    (stepId) => preservedById.has(stepId) || loadedById.has(stepId),
  )
  const result: Array<(typeof steps)[number] | WorkflowPreservedStep> = []
  for (const stepId of originalOrder) {
    result.push(preservedById.get(stepId) ?? loadedById.get(stepId)!)
  }
  for (const step of steps) {
    if (!currentLoadedStepOrderSet.has(step.id)) {
      result.push(step)
    }
  }

  return { steps: result }
}

// Original step order of the graph currently loaded in the designer — set by
// parseWorkflowTemplate, consumed by buildWorkflowGraph to keep preserved
// steps at their original positions (W10). Module state is acceptable here
// because the designer edits exactly one template at a time and both
// functions are pure otherwise.
let currentLoadedStepOrder: string[] = []
let currentLoadedStepOrderSet = new Set<string>()

const setLoadedWorkflowStepOrder = (stepIds: string[]) => {
  currentLoadedStepOrder = stepIds
  currentLoadedStepOrderSet = new Set(stepIds)
}

// Position in the loaded graph, for nodes that were on the canvas: used to
// keep the original implicit sequence for steps the author never connected.
const loadedCanvasIndex = (nodeId: string): number => {
  const index = currentLoadedStepOrder.indexOf(nodeId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

// W13: canvas trigger nodes are labelled entry markers, not trigger
// authoring. `triggersJson` carries the node's identity (label, type, canvas
// position) so a load → save cycle keeps the marker — real schedules are
// AgentTriggers created on the installation's Triggers surface, and no
// cron/timezone/interval config is ever persisted from the canvas.
export const buildWorkflowTriggers = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
) =>
  nodes
    .filter((node) => node.type === 'trigger')
    .map((node) => ({
      config: {},
      id: node.id,
      meta: node.meta,
      name: node.label,
      position: {
        x: Math.round(node.x),
        y: Math.round(node.y),
      },
      sourceId: node.sourceId,
      targetNodeIds: connections
        .filter((connection) => connection.fromNodeId === node.id)
        .map((connection) => connection.toNodeId),
      title: node.label,
      type: node.sourceId,
    }))

export type ParsedWorkflowTemplate = Pick<
  WorkflowDesignerDraft,
  'connections' | 'nodes'
> & {
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
  setLoadedWorkflowStepOrder(graph.steps.map((step) => step.id))

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
    nodes: allNodes,
    preservedSteps,
  }
}
