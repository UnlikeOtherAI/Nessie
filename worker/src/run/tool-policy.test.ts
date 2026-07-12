import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolDefinition } from '@nessie/runtime'

import { authorizeToolCall } from './tool-policy.js'

/**
 * Builtin authorization for `requiresExplicitGrant` tools (e.g.
 * `deep_water_run_update`): OFF by default for every agent, allowed only with an
 * explicit per-agent policy allow — grantable to PA and shared agents alike.
 */

const dwTool: BuiltinToolDefinition = {
  id: 'deep_water_run_update',
  label: 'Deep Water Run Update',
  description: 'x',
  parameters: { type: 'object', properties: {}, required: [] },
  safe: true,
  requiresExplicitGrant: true,
}

const plainTool: BuiltinToolDefinition = {
  id: 'web_search',
  label: 'Web Search',
  description: 'x',
  parameters: { type: 'object', properties: {}, required: [] },
  safe: true,
}

const defs = [dwTool, plainTool]
const enabled = new Set(defs.map((d) => d.id))

test('explicit-grant builtin is denied by default for a shared agent', () => {
  const decision = authorizeToolCall('deep_water_run_update', enabled, defs, null, null, 'shared')
  assert.deepEqual(decision, { allowed: false, reason: 'tool_not_granted' })
})

test('explicit-grant builtin is denied by default for a personal assistant', () => {
  const decision = authorizeToolCall(
    'deep_water_run_update', enabled, defs, null, null, 'personal_assistant',
  )
  assert.deepEqual(decision, { allowed: false, reason: 'tool_not_granted' })
})

test('explicit-grant builtin is allowed with an explicit grant (shared agent)', () => {
  const decision = authorizeToolCall(
    'deep_water_run_update', enabled, defs, { deep_water_run_update: true }, null, 'shared',
  )
  assert.deepEqual(decision, { allowed: true })
})

test('explicit-grant builtin is allowed with an explicit grant (personal assistant)', () => {
  const decision = authorizeToolCall(
    'deep_water_run_update',
    enabled,
    defs,
    { deep_water_run_update: true },
    null,
    'personal_assistant',
  )
  assert.deepEqual(decision, { allowed: true })
})

test('an explicit deny still blocks the explicit-grant builtin', () => {
  const decision = authorizeToolCall(
    'deep_water_run_update', enabled, defs, { deep_water_run_update: false }, null, 'shared',
  )
  assert.deepEqual(decision, { allowed: false, reason: 'agent_policy_denied' })
})

test('ordinary builtins stay allowed by default (no regression)', () => {
  const decision = authorizeToolCall('web_search', enabled, defs, null, null, 'shared')
  assert.deepEqual(decision, { allowed: true })
})
