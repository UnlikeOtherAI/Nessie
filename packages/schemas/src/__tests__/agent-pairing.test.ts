import assert from 'node:assert/strict'
import test from 'node:test'

import { agentPairingAllowed } from '../agent-pairing.js'

// Absent and malformed are opposite cases and take opposite answers, which is
// the whole content of this helper.
test('an installation that never set the key keeps pairing', () => {
  assert.equal(agentPairingAllowed(null), true)
  assert.equal(agentPairingAllowed(undefined), true)
})

test('an explicit decision is honoured in both directions', () => {
  assert.equal(agentPairingAllowed({ allowed: true }), true)
  assert.equal(agentPairingAllowed({ allowed: false }), false)
})

test('a present but unreadable value denies rather than granting', () => {
  // Somebody wrote these rows to express a decision. Reading a string "false",
  // or a shape that no longer parses, as permission would grant exactly the
  // thing they sat down to forbid — a security switch that fails open is not a
  // switch.
  assert.equal(agentPairingAllowed({ allowed: 'false' }), false)
  assert.equal(agentPairingAllowed({ allow: false }), false)
  assert.equal(agentPairingAllowed('nonsense'), false)
  assert.equal(agentPairingAllowed({ allowed: false, extra: 1 }), false)
})
