import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

test('Agent Designer trigger update exposes every editable lifecycle field', () => {
  const tool = BUILTIN_TOOL_DEFINITIONS.find(({ id }) => id === 'agent_trigger_update')
  assert.ok(tool)
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), [
    'config', 'description', 'enabled', 'name', 'nextRunAt', 'status',
    'targetChannelId', 'targetThreadId', 'triggerId',
  ])
  assert.deepEqual(tool.parameters.required, ['triggerId'])
  assert.equal(tool.identityDelegatedOnly, true)
})
