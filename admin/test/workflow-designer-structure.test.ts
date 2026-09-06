import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeWorkflowCanvasStructure } from '../src/lib/workflow-designer/canvas-structure'
import {
  buildWorkflowGraph,
  buildWorkflowTriggers,
  WorkflowCanvasStructureError,
} from '../src/lib/workflow-designer/graph-serialization'
import { parseWorkflowTemplate } from '../src/lib/workflow-designer/template-parsing'
import { isInvalidWorkflowConnection } from '../src/lib/workflow-designer/geometry'
import type {
  WorkflowCanvasNode,
  WorkflowConnection,
} from '../src/lib/workflow-designer/types'

// W10/W11/W13: the designer must preserve steps it cannot render, refuse to
// save graph shapes the runner cannot execute, and treat trigger nodes as
// labelled markers instead of trigger authoring.

const node = (
  id: string,
  type: WorkflowCanvasNode['type'] = 'tool',
  extra: Partial<WorkflowCanvasNode> = {},
): WorkflowCanvasNode => ({
  id,
  label: id,
  config: { toolName: 'state_get' },
  sourceId: id,
  type,
  x: 0,
  y: 0,
  ...extra,
})

const connection = (fromNodeId: string, toNodeId: string): WorkflowConnection => ({
  fromNodeId,
  id: `${fromNodeId}->${toNodeId}`,
  toNodeId,
})

test('W11: multiple outgoing edges are rejected', () => {
  const connections = [connection('a', 'b')]
  assert.equal(
    isInvalidWorkflowConnection({ fromNodeId: 'a', toNodeId: 'c' }, connections),
    true,
  )
})

test('W11: multiple incoming edges (merges) are rejected', () => {
  const connections = [connection('a', 'c')]
  assert.equal(
    isInvalidWorkflowConnection({ fromNodeId: 'b', toNodeId: 'c' }, connections),
    true,
  )
})

test('W11: cycles are rejected', () => {
  const connections = [connection('a', 'b'), connection('b', 'c')]
  assert.equal(
    isInvalidWorkflowConnection({ fromNodeId: 'c', toNodeId: 'a' }, connections),
    true,
  )
  assert.equal(
    isInvalidWorkflowConnection({ fromNodeId: 'c', toNodeId: 'c' }, connections),
    true,
  )
  // Duplicates still rejected.
  assert.equal(
    isInvalidWorkflowConnection({ fromNodeId: 'a', toNodeId: 'b' }, connections),
    true,
  )
})

test('W11: a single forward chain is accepted', () => {
  const connections = [connection('a', 'b')]
  assert.equal(
    isInvalidWorkflowConnection({ fromNodeId: 'b', toNodeId: 'c' }, connections),
    false,
  )
})

test('W11: analysis requires exactly one connected chain', () => {
  const a = node('a')
  const b = node('b')
  const c = node('c')

  assert.deepEqual(analyzeWorkflowCanvasStructure([], []).kind, 'empty')

  const chain = analyzeWorkflowCanvasStructure([a, b, c], [
    connection('a', 'b'),
    connection('b', 'c'),
  ])
  assert.equal(chain.kind, 'chain')
  if (chain.kind === 'chain') {
    assert.deepEqual(chain.orderedNodes.map((entry) => entry.id), ['a', 'b', 'c'])
  }

  // Disconnected component: the old serializer appended it to the end and
  // the runner executed it; now it is a structure error.
  assert.equal(
    analyzeWorkflowCanvasStructure([a, b, c], [connection('a', 'b')]).kind,
    'invalid',
  )
  // Cycle.
  assert.equal(
    analyzeWorkflowCanvasStructure([a, b], [connection('a', 'b'), connection('b', 'a')]).kind,
    'invalid',
  )
})

test('W11: buildWorkflowGraph refuses disconnected nodes instead of linearizing them', () => {
  assert.throws(
    () => buildWorkflowGraph([node('a'), node('b')], []),
    WorkflowCanvasStructureError,
  )
})

test('W11: buildWorkflowGraph serializes a chain in edge order, not canvas order', () => {
  const graph = buildWorkflowGraph(
    [node('b'), node('a'), node('c')],
    [connection('a', 'b'), connection('b', 'c')],
  )
  assert.deepEqual(graph.steps.map((step) => step.id), ['a', 'b', 'c'])
})

test('W10: parseWorkflowTemplate preserves unrenderable steps verbatim', () => {
  const parsed = parseWorkflowTemplate(
    {
      steps: [
        { id: 'a', input: { toolName: 'state_get' }, title: 'A', type: 'tool_call' },
        {
          id: 'env',
          input: { templateId: 'tpl-1', workflowDesigner: { position: { x: 5, y: 5 } } },
          title: 'Env',
          type: 'environment_launch',
        },
        { id: 'b', input: { toolName: 'state_put' }, title: 'B', type: 'tool_call' },
      ],
    },
    [],
    null,
  )

  // The environment_launch step never became a canvas node...
  assert.deepEqual(parsed.nodes.map((entry) => entry.id), ['a', 'b'])
  // ...but it is preserved verbatim for the save path.
  assert.deepEqual(parsed.preservedSteps, [
    {
      id: 'env',
      input: { templateId: 'tpl-1', workflowDesigner: { position: { x: 5, y: 5 } } },
      title: 'Env',
      type: 'environment_launch',
    },
  ])

  // Saving splices it back at its ORIGINAL position — not appended, not dropped.
  const graph = buildWorkflowGraph(
    parsed.nodes,
    parsed.connections,
    parsed.preservedSteps,
    parsed.loadedStepOrder,
  )
  assert.deepEqual(graph.steps.map((step) => step.id), ['a', 'env', 'b'])
  assert.equal(graph.steps[1]?.type, 'environment_launch')
  assert.deepEqual(graph.steps[1]?.input, {
    templateId: 'tpl-1',
    workflowDesigner: { position: { x: 5, y: 5 } },
  })
})

test('W10: canvas round-trip keeps input keys the inspector does not edit', () => {
  const parsed = parseWorkflowTemplate(
    {
      steps: [
        {
          id: 'a',
          input: { channelId: 'chan-1', prompt: 'hi', toolName: 'state_get' },
          title: 'A',
          type: 'tool_call',
        },
      ],
    },
    [],
    null,
  )
  const graph = buildWorkflowGraph(
    parsed.nodes,
    parsed.connections,
    parsed.preservedSteps,
    parsed.loadedStepOrder,
  )
  const stepInput = graph.steps[0]?.input ?? {}
  assert.equal(stepInput.channelId, 'chan-1')
  assert.equal(stepInput.prompt, 'hi')
})

test('W10: loadedStepOrder is an explicit parameter, not shared state across calls', () => {
  // One "designer instance" loaded a graph with an original order of a, c, b
  // (c and b never connected, so the implicit sequence is all that orders
  // them).
  const firstLoadedOrder = ['a', 'c', 'b']
  const graphOne = buildWorkflowGraph(
    [node('a'), node('b'), node('c')],
    [],
    [],
    firstLoadedOrder,
  )
  assert.deepEqual(graphOne.steps.map((step) => step.id), ['a', 'c', 'b'])

  // A second, unrelated call that never loaded anything must not inherit the
  // first call's order — this is exactly the cross-instance corruption the
  // module-level singleton risked (audit 06-F11): with `loadedStepOrder`
  // threaded explicitly, two disconnected nodes with no loaded order of their
  // own still refuse to save instead of silently reusing `firstLoadedOrder`.
  assert.throws(
    () => buildWorkflowGraph([node('x'), node('y')], []),
    WorkflowCanvasStructureError,
  )
})

test('W13: trigger nodes save as labelled markers — no schedule config round-trips', () => {
  const triggers = buildWorkflowTriggers(
    [
      node('t', 'trigger', {
        config: { cron: '0 * * * *', timezone: 'Europe/London', type: 'scheduled' },
        sourceId: 'scheduled',
      }),
    ],
    [connection('t', 'a')],
  )
  assert.equal(triggers.length, 1)
  assert.deepEqual(triggers[0]?.config, {})
  assert.equal(triggers[0]?.type, 'scheduled')
  assert.deepEqual(triggers[0]?.targetNodeIds, ['a'])
})
