import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorStandingPolicyPrepareInputSchema,
  STANDING_POLICY_LIMIT_DEFAULTS,
  StandingPolicyLimitsSchema,
} from '../executor-standing-policy.js'

const TRIGGER = '10000000-0000-4000-8000-000000000001'
const MACHINE = '10000000-0000-4000-8000-000000000002'

test('a limit sent as a string is the number it says', () => {
  assert.deepEqual(StandingPolicyLimitsSchema.parse({ dailyUsd: '60', ticketHours: '4', ticketUsd: '20' }),
    { dailyUsd: 60, ticketHours: 4, ticketUsd: 20 })
  const prepared = ExecutorStandingPolicyPrepareInputSchema.parse({
    executorIds: [MACHINE], limits: { ticketUsd: '20' }, triggerId: TRIGGER,
  })
  assert.equal(prepared.limits.ticketUsd, 20)
  assert.equal(prepared.limits.ticketHours, STANDING_POLICY_LIMIT_DEFAULTS.ticketHours)
})

test('a limit that is no number, zero or above its ceiling is still refused', () => {
  for (const ticketUsd of ['twenty', '0', '', '100000']) {
    assert.equal(StandingPolicyLimitsSchema.safeParse({ ticketUsd }).success, false, ticketUsd)
  }
})
