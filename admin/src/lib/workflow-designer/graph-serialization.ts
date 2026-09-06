import { getWorkflowRuntimeStepType } from './node-sources'
import { analyzeWorkflowCanvasStructure, buildExecutableNodeConfig } from './canvas-structure'
import type { WorkflowCanvasNode, WorkflowConnection } from './types'

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

// Position in a loaded graph, for nodes that were on the canvas: used to keep
// the original implicit sequence for steps the author never connected.
const loadedCanvasIndex = (loadedStepOrder: string[], nodeId: string): number => {
  const index = loadedStepOrder.indexOf(nodeId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export const buildWorkflowGraph = (
  nodes: WorkflowCanvasNode[],
  connections: WorkflowConnection[],
  preservedSteps: WorkflowPreservedStep[] = [],
  // Original step order of the graph this designer loaded from — the caller
  // is `parseWorkflowTemplate`'s own `ParsedWorkflowTemplate.loadedStepOrder`
  // for a save immediately following a load, or `[]` for a brand-new graph.
  // An explicit parameter rather than module state: two designer instances
  // (e.g. two browser tabs) each carry their own loaded order instead of
  // silently corrupting one another's.
  loadedStepOrder: string[] = [],
) => {
  // W10: unknown/unrenderable steps never became canvas nodes; the caller
  // passes them in as `preservedSteps` and they are written back verbatim at
  // their original graph position. Steps that DID load onto the canvas must
  // form exactly one connected chain (W11) — saving an unexecutable shape
  // is an explicit error, not a silent linearization that would run steps
  // the author disconnected.
  const canvasNodeIds = new Set(nodes.map((node) => node.id))
  const loadedStepOrderSet = new Set(loadedStepOrder)

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
      !loadedStepOrderSet.has(node.id) &&
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
      executableNodes.every((node) => loadedStepOrderSet.has(node.id))
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
          (left, right) =>
            loadedCanvasIndex(loadedStepOrder, left.id) -
            loadedCanvasIndex(loadedStepOrder, right.id),
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
  const originalOrder = loadedStepOrder.filter(
    (stepId) => preservedById.has(stepId) || loadedById.has(stepId),
  )
  const result: Array<(typeof steps)[number] | WorkflowPreservedStep> = []
  for (const stepId of originalOrder) {
    result.push(preservedById.get(stepId) ?? loadedById.get(stepId)!)
  }
  for (const step of steps) {
    if (!loadedStepOrderSet.has(step.id)) {
      result.push(step)
    }
  }

  return { steps: result }
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
