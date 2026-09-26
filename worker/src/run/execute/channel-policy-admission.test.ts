import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'

import { concludesQuietly } from './channel-policy-admission.js'

/**
 * Configured policy work that has nothing to report answers with a bare mark,
 * and that answer is not posted (docs/standards/channel-decision-policy.md).
 * Both halves are structural: who the run acts as, and whether its answer says
 * anything at all. The fixtures are Czech, slang and misspelled on purpose.
 */

const runActingAs = (purpose: string | undefined) => ({
  actorContext: {
    actionContext: { requestId: 'policy-work', ...(purpose ? { purpose } : {}) },
    actor: { actorId: '11111111-1111-4111-8111-111111111111', actorType: 'user' },
    tenant: { organizationId: '22222222-2222-4222-8222-222222222222' },
  },
}) as unknown as RunExecuteJobPayload

const policyWork = runActingAs('channel.policy')

test('policy work that answers with the bare mark ends quietly', () => {
  for (const answer of ['✅', ' ✅\n', '✅.', '']) {
    assert.equal(concludesQuietly(policyWork, answer), true, JSON.stringify(answer))
  }
})

test('policy work with anything to say in words is posted', () => {
  for (const answer of [
    '✅ Zapsal jsem rozhodnutí do logu.',
    'couldnt find teh decision log, pls share it',
    'Hotovo',
    '3',
  ]) {
    assert.equal(concludesQuietly(policyWork, answer), false, answer)
  }
})

test('a run acting for anyone but a channel policy is never silenced by its text', () => {
  // A person's own turn, and a reply under a policy channel that answers the
  // person who posted: both owe their reader whatever they wrote.
  assert.equal(concludesQuietly(runActingAs(undefined), '✅'), false)
  assert.equal(concludesQuietly(runActingAs('chat'), '✅'), false)
})
