import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import {
  agentOwnershipState,
  canChangeAgentOwner,
  canEditAgentRecord,
} from '../src/components/features/agents/agent-edit-authority'

/**
 * The client half of `canEditAgent`. It decides which affordances are painted,
 * so it has to answer exactly what the server answers — a button that 403s is
 * worse than no button. These cases mirror `api/test/agent-edit-authority.test.ts`.
 */

const steward = '00000000-0000-4000-8000-0000000000a1'
const otherMember = '00000000-0000-4000-8000-0000000000a2'

const agent = (overrides: Partial<AgentRecord>): AgentRecord => ({
  channelIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  id: '00000000-0000-4000-8000-0000000000b1',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  name: 'Researcher',
  ownerUserId: null,
  role: 'assistant',
  status: 'idle',
  todosEnabled: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  visibility: 'workspace',
  ...overrides,
} as AgentRecord)

const member = { isOrgOwner: false, userId: otherMember }
const owner = { isOrgOwner: false, userId: steward }
const orgOwner = { isOrgOwner: true, userId: otherMember }

test('a private agent is editable by its owner alone — org owners included', () => {
  const priv = agent({ ownerUserId: steward, visibility: 'private' })
  assert.equal(agentOwnershipState(priv), 'private')
  assert.equal(canEditAgentRecord(priv, owner), true)
  assert.equal(canEditAgentRecord(priv, member), false)
  assert.equal(canEditAgentRecord(priv, orgOwner), false)
  // Its owner is encoded in the owner-only home DM, so transfer is refused.
  assert.equal(canChangeAgentOwner(priv, owner), false)
})

test('a person-owned workspace agent admits its steward and org owners', () => {
  const owned = agent({ ownerUserId: steward })
  assert.equal(agentOwnershipState(owned), 'person_owned')
  assert.equal(canEditAgentRecord(owned, owner), true)
  assert.equal(canEditAgentRecord(owned, orgOwner), true)
  assert.equal(canEditAgentRecord(owned, member), false)
  // Release is the owner's or an org owner's act, never a mere editor's.
  assert.equal(canChangeAgentOwner(owned, owner), true)
  assert.equal(canChangeAgentOwner(owned, orgOwner), true)
  assert.equal(canChangeAgentOwner(owned, member), false)
})

test('a team-owned agent is editable by anyone it reached, but claimable only by an org owner', () => {
  const shared = agent({})
  assert.equal(agentOwnershipState(shared), 'team_owned')
  // Reaching this component through the entitlement-scoped agent list IS the
  // entitlement, so no second question is asked here.
  assert.equal(canEditAgentRecord(shared, member), true)
  assert.equal(canChangeAgentOwner(shared, member), false)
  assert.equal(canChangeAgentOwner(shared, orgOwner), true)
})

test('a blueprint-managed agent is nobody’s to edit', () => {
  for (const system of [
    agent({ systemManaged: true }),
    agent({ agentKind: 'personal_assistant' }),
  ]) {
    assert.equal(agentOwnershipState(system), 'system')
    assert.equal(canEditAgentRecord(system, orgOwner), false)
    assert.equal(canChangeAgentOwner(system, orgOwner), false)
  }
})

test('a signed-out viewer edits nothing owned by a person', () => {
  const anonymous = { isOrgOwner: false, userId: null }
  assert.equal(
    canEditAgentRecord(agent({ ownerUserId: steward, visibility: 'private' }), anonymous),
    false,
  )
  assert.equal(canEditAgentRecord(agent({ ownerUserId: steward }), anonymous), false)
})
