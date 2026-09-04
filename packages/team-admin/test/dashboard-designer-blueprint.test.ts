import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

import {
  DASHBOARD_DESIGNER_BLUEPRINT,
  DASHBOARD_DESIGNER_SLUG,
  getGlobalAgentBlueprint,
  listGlobalAgentBlueprints,
} from '../src/global-agent-blueprints.js'

test('Dashboard Designer is a registered global specialist with the dashboard workflow', () => {
  assert.equal(getGlobalAgentBlueprint(DASHBOARD_DESIGNER_SLUG), DASHBOARD_DESIGNER_BLUEPRINT)
  assert.ok(listGlobalAgentBlueprints().includes(DASHBOARD_DESIGNER_BLUEPRINT))
  assert.deepEqual(DASHBOARD_DESIGNER_BLUEPRINT.identityToolIds, [])

  for (const toolId of [
    'dashboard_create',
    'dashboard_source_probe',
    'dashboard_widget_add',
    'dashboard_widget_update',
    'dashboard_widget_move',
    'dashboard_present',
  ]) {
    assert.equal(DASHBOARD_DESIGNER_BLUEPRINT.toolPolicy[toolId], true)
    assert.ok(BUILTIN_TOOL_DEFINITIONS.some((tool) => tool.id === toolId), toolId)
  }

  assert.equal(DASHBOARD_DESIGNER_BLUEPRINT.toolPolicy.dashboard_source_set_credential, false)
})
