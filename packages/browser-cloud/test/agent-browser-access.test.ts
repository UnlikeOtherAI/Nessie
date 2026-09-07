import assert from 'node:assert/strict'
import test from 'node:test'

import { agentBrowserLoginStatus } from '../src/agent-browser-access.js'

test('a shared jar with human provenance is quarantined', () => {
  assert.deepEqual(agentBrowserLoginStatus({ loginCount: 1, principalUserId: null }), {
    kind: 'legacy_team_human',
    permitsSensitiveUse: false,
  })
})

test('unsigned shared jars and person-owned jars retain their distinct access state', () => {
  assert.deepEqual(agentBrowserLoginStatus({ loginCount: 0, principalUserId: null }), {
    kind: 'unsigned',
    permitsSensitiveUse: true,
  })
  assert.deepEqual(agentBrowserLoginStatus({ loginCount: 1, principalUserId: 'person-1' }), {
    kind: 'personal',
    permitsSensitiveUse: true,
  })
})
