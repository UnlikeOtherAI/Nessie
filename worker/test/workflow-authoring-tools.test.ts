import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

test('agents are offered the complete workflow authoring lifecycle', () => {
  const definitions = new Map(BUILTIN_TOOL_DEFINITIONS.map((definition) => [definition.id, definition]))

  for (const id of [
    'workflow_create',
    'workflow_install',
    'workflow_list',
    'workflow_trigger_create',
    'workflow_preview',
  ]) {
    assert.ok(definitions.has(id), `${id} must be discoverable to an agent`)
  }

  const trigger = definitions.get('workflow_trigger_create')
  const type = trigger?.parameters.properties?.['type'] as { enum?: unknown[] } | undefined
  assert.deepEqual(type?.enum, ['manual', 'scheduled', 'interval', 'webhook', 'event'])
})
