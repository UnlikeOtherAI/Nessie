import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorkspaceMemberRecord } from '@nessie/schemas'
import type { AgentRecord } from '../src/lib/api-client'
import { buildPeopleAgentsTree } from '../src/components/features/members/people-agents-tree'

const agent = (overrides: Partial<AgentRecord> & { id: string }): AgentRecord => ({
  channelIds: [],
  createdAt: '2026-08-29T00:00:00.000Z',
  lastActivityAt: '2026-08-29T00:00:00.000Z',
  name: overrides.id,
  role: 'assistant',
  status: 'idle',
  todosEnabled: false,
  updatedAt: '2026-08-29T00:00:00.000Z',
  ...overrides,
})

const member = (uoaSub: string, userId?: string): WorkspaceMemberRecord => ({
  displayName: uoaSub,
  uoaSub,
  ...(userId ? { userId } : {}),
})

test('each person is listed with the agents they steward', () => {
  const tree = buildPeopleAgentsTree(
    [member('sub-a', 'user-a'), member('sub-b', 'user-b')],
    [
      agent({ id: 'a1', ownerUserId: 'user-a' }),
      agent({ id: 'a2', ownerUserId: 'user-a' }),
      agent({ id: 'b1', ownerUserId: 'user-b' }),
    ],
  )

  assert.deepEqual(
    tree.people.map((person) => [person.member.uoaSub, person.agents.map((one) => one.id)]),
    [['sub-a', ['a1', 'a2']], ['sub-b', ['b1']]],
  )
  assert.deepEqual(tree.unowned, [])
  assert.deepEqual(tree.ownedOutsideWorkspace, [])
})

test('a person with no local row renders with no agents rather than vanishing', () => {
  // Somebody UOA knows who has never signed into Nessie has no local user row,
  // so nothing can be owned by them yet — but they are still on the team.
  const tree = buildPeopleAgentsTree(
    [member('sub-never-signed-in')],
    [agent({ id: 'a1', ownerUserId: 'user-a' })],
  )

  assert.equal(tree.people.length, 1)
  assert.deepEqual(tree.people[0]?.agents, [])
})

test('spawned subtask children are excluded from every bucket', () => {
  const tree = buildPeopleAgentsTree(
    [member('sub-a', 'user-a')],
    [
      agent({ id: 'parent', ownerUserId: 'user-a' }),
      agent({ id: 'child', ownerUserId: 'user-a', parentAgentId: 'parent' }),
    ],
  )

  assert.deepEqual(tree.people[0]?.agents.map((one) => one.id), ['parent'])
  assert.deepEqual(tree.unowned, [])
  assert.deepEqual(tree.system, [])
})

test('system agents are their own bucket, never a person\'s staff', () => {
  const tree = buildPeopleAgentsTree(
    [member('sub-a', 'user-a')],
    [
      agent({ agentKind: 'personal_assistant', id: 'pa', systemManaged: true }),
      agent({ id: 'librarian', systemManaged: true }),
    ],
  )

  assert.deepEqual(tree.system.map((one) => one.id), ['pa', 'librarian'])
  assert.deepEqual(tree.people[0]?.agents, [])
})

test('an owner absent from this team roster is separated from genuinely unowned', () => {
  // The roster is team-keyed, so "not in this roster" covers an active
  // colleague on another team as well as someone who left. Keeping the two
  // buckets apart is what stops the UI calling present colleagues departed.
  const tree = buildPeopleAgentsTree(
    [member('sub-a', 'user-a')],
    [
      agent({ id: 'mine', ownerUserId: 'user-a' }),
      agent({ id: 'elsewhere', ownerUserId: 'user-other-team' }),
      agent({ id: 'nobody' }),
    ],
  )

  assert.deepEqual(tree.people[0]?.agents.map((one) => one.id), ['mine'])
  assert.deepEqual(tree.ownedOutsideWorkspace.map((one) => one.id), ['elsewhere'])
  assert.deepEqual(tree.unowned.map((one) => one.id), ['nobody'])
})
