import assert from 'node:assert/strict'
import test from 'node:test'

import { runWorkflowTransformPreviewTool } from './workflow-transform.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

// §5 agent authoring: the preview runs the same evaluator with the same
// envelope — deterministic, no LLM in the loop. The context is unused (no
// I/O at all); the cast keeps the unit light.
const context = {} as BuiltinToolRuntimeContext

test('workflow_transform_preview evaluates the expression against the sample', async () => {
  const result = await runWorkflowTransformPreviewTool(
    context,
    'items[?stock > `0`].{name: title}',
    { items: [{ title: 'a', stock: 3 }, { title: 'b', stock: 0 }] },
  )
  assert.equal(result.toolName, 'workflow_transform_preview')
  assert.deepEqual(JSON.parse(result.outputPreview), [{ name: 'a' }])
})

test('workflow_transform_preview accepts a JSON string sample', async () => {
  const result = await runWorkflowTransformPreviewTool(
    context,
    'foo.bar',
    '{"foo": {"bar": 42}}',
  )
  assert.equal(result.outputPreview, '42')
})

test('workflow_transform_preview reports a JMESPath error as tool output, not a throw', async () => {
  const result = await runWorkflowTransformPreviewTool(context, 'round(`1`, `2`)', {})
  assert.match(result.outputPreview, /JMESPath error:/)
})

test('workflow_transform_preview rejects a non-JSON string sample', async () => {
  await assert.rejects(
    runWorkflowTransformPreviewTool(context, 'a', 'not json'),
    /must be valid JSON/,
  )
})

test('workflow_transform_preview enforces the expression envelope', async () => {
  const result = await runWorkflowTransformPreviewTool(
    context,
    `'${'x'.repeat(5 * 1024)}'`,
    {},
  )
  assert.match(result.outputPreview, /exceeds/)
})
