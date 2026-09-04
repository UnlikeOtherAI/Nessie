import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWorkflowPreviewGraph } from '../src/components/features/workflows/WorkflowTemplatePreviewCanvas'
import type { WorkflowTemplateRecord } from '../src/lib/api-client'

const template = (graph: WorkflowTemplateRecord['graph']): WorkflowTemplateRecord => ({
  bindingSchema: {},
  createdAt: '2026-09-04T09:00:00.000Z',
  createdByActorId: 'agent',
  createdByActorType: 'agent',
  graph,
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Previewable workflow',
  organizationId: '123e4567-e89b-12d3-a456-426614174001',
  requiredEnvironmentTemplateIds: [],
  source: 'authored',
  triggers: {},
  updatedAt: '2026-09-04T09:00:00.000Z',
  variableSchema: {},
  version: 1,
})

test('agent-authored sequential graph gets live preview connections', () => {
  const preview = buildWorkflowPreviewGraph(template({
    steps: [
      { id: 'read', input: { toolName: 'state_get' }, title: 'Read state', type: 'tool_call' },
      { id: 'post', input: { body: 'Done' }, title: 'Post result', type: 'message_send' },
    ],
  }))

  assert.deepEqual(preview.nodes.map((node) => node.id), ['read', 'post'])
  assert.deepEqual(preview.connections.map((connection) => [
    connection.fromNodeId,
    connection.toNodeId,
  ]), [['read', 'post']])
  assert.ok(preview.width > 0)
  assert.ok(preview.height > 0)
})

test('preview uses a designer-authored edge when it exists', () => {
  const preview = buildWorkflowPreviewGraph(template({
    steps: [
      {
        id: 'read',
        input: {
          toolName: 'state_get',
          workflowDesigner: { outgoingNodeIds: ['post'] },
        },
        type: 'tool_call',
      },
      { id: 'post', input: { body: 'Done' }, type: 'message_send' },
    ],
  }))

  assert.equal(preview.connections.length, 1)
  assert.equal(preview.connections[0]?.fromNodeId, 'read')
  assert.equal(preview.connections[0]?.toNodeId, 'post')
})
