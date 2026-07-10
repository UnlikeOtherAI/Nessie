import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_DEFINITIONS,
  DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION,
} from '../src/index.js'

test('Deep Water run update is a Personal Assistant builtin tool', () => {
  assert.equal(DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION.id, 'deep_water_run_update')
  assert.equal(DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION.personalAssistantOnly, true)
  assert.equal(DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION.safe, true)
  assert.deepEqual(DEEP_WATER_RUN_UPDATE_TOOL_DEFINITION.parameters.required, [
    'runId',
    'status',
  ])
})

test('builtin registry includes the Deep Water run update tool', () => {
  const tool = BUILTIN_TOOL_DEFINITIONS.find((definition) =>
    definition.id === 'deep_water_run_update'
  )

  assert.ok(tool)
  assert.equal(tool.label, 'Deep Water Run Update')
  assert.equal(tool.personalAssistantOnly, true)
})
