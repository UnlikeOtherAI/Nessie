import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GOOGLE_WORKSPACE_CAPABILITIES,
  googleWorkspaceStartInput,
} from '../src/pages/settings/connections/google-workspace-connect.js'

test('Calendar and Meet first-connect sends only the selected Google capabilities', () => {
  const input = googleWorkspaceStartInput(['calendar.freebusy', 'meet.create'])

  assert.deepEqual(input, {
    capabilities: ['calendar.freebusy', 'meet.create'],
    provider: 'google',
  })
  assert.deepEqual(
    GOOGLE_WORKSPACE_CAPABILITIES.map((capability) => capability.id),
    ['calendar.read', 'calendar.freebusy', 'calendar.write', 'meet.create'],
  )
  assert.ok(!GOOGLE_WORKSPACE_CAPABILITIES.some((capability) => capability.id.startsWith('gmail.')))
})
