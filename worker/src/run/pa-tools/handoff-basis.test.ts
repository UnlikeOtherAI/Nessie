import assert from 'node:assert/strict'
import test from 'node:test'

import { computeHandoffBriefBasis } from './agent-handoff.js'

/**
 * The handoff brief's basis, in both directions.
 *
 * The sharp edge is the second subtraction: the requester is the only member of
 * the destination DM, so stamping a scope they already satisfy would make every
 * later reply there unreadable by the one person it is for — the specialist
 * silenced in its own home. Subtracting it withholds nothing, because they heard
 * that content in the origin thread already.
 *
 * The other direction must keep failing closed: a scope the requester does NOT
 * satisfy survives onto the brief.
 */

const destination = {
  channelId: 'chan-designer',
  organizationId: 'org-1',
  projectId: 'proj-1',
  teamId: 'team-system',
}

test('a scope the requester already satisfies never reaches the brief', () => {
  const basis = computeHandoffBriefBasis({
    consumed: [
      { scopeId: 'user-1', scopeType: 'user' },
      { scopeId: 'chan-private', scopeType: 'channel' },
    ],
    destination,
    requesterScopes: [
      { scopeId: 'user-1', scopeType: 'user' },
      { scopeId: 'chan-private', scopeType: 'channel' },
      { scopeId: 'org-1', scopeType: 'organization' },
    ],
    targetAgentId: 'agent-designer',
  })
  assert.deepEqual(basis, [])
})

test('a scope the requester cannot satisfy is stamped on the brief', () => {
  const basis = computeHandoffBriefBasis({
    consumed: [
      { scopeId: 'user-1', scopeType: 'user' },
      { scopeId: 'chan-somebody-elses', scopeType: 'channel' },
    ],
    destination,
    requesterScopes: [
      { scopeId: 'user-1', scopeType: 'user' },
      { scopeId: 'org-1', scopeType: 'organization' },
    ],
    targetAgentId: 'agent-designer',
  })
  assert.deepEqual(basis, [{ scopeId: 'chan-somebody-elses', scopeType: 'channel' }])
})

test('the destination DM and its own agent imply their scopes, as anywhere else', () => {
  const basis = computeHandoffBriefBasis({
    consumed: [
      { scopeId: 'chan-designer', scopeType: 'channel' },
      { scopeId: 'team-system', scopeType: 'team' },
      { scopeId: 'agent-designer', scopeType: 'agent' },
      { scopeId: 'thought-space', scopeType: 'project' },
    ],
    destination,
    requesterScopes: [],
    targetAgentId: 'agent-designer',
  })
  assert.deepEqual(basis, [{ scopeId: 'thought-space', scopeType: 'project' }])
})
