import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

import { executeBuiltinTool } from './tools.js'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

test('a failed stubbed builtin carries its full argument schema', async () => {
  const toolName = 'schedule_task'
  const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolName)
  assert.ok(definition)

  // Missing instructions fails before this handler needs any runtime service.
  const result = await executeBuiltinTool(
    toolName,
    {},
    {} as BuiltinToolRuntimeContext,
    new Set([toolName]),
  )

  assert.equal(result.success, false)
  assert.match(result.output, /Exact argument schema for schedule_task:/)
  assert.ok(result.output.includes(JSON.stringify(definition.parameters, null, 2)))
})

test('an inline builtin failure is unchanged', async () => {
  const result = await executeBuiltinTool(
    'schedule_task',
    {},
    {} as BuiltinToolRuntimeContext,
  )

  assert.equal(result.success, false)
  assert.doesNotMatch(result.output, /Exact argument schema/)
})
