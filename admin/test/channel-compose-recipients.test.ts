import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord, UserRecord } from '../src/lib/api-client'
import {
  buildRecipientOptions,
  selectAddressableAgents,
} from '../src/lib/channel-compose-recipients.js'

const agent = (overrides: Partial<AgentRecord>): AgentRecord =>
  ({
    agentKind: 'shared',
    id: overrides.id ?? 'agent-1',
    name: 'Agent',
    role: 'assistant',
    systemManaged: false,
    visibility: 'team',
    ...overrides,
  }) as AgentRecord

const designer = agent({
  dmAddressable: true,
  id: 'designer',
  name: 'Agent Designer',
  role: 'agent designer',
  systemManaged: true,
  systemSlug: 'agent-designer',
})
const personalAssistant = agent({
  agentKind: 'personal_assistant',
  dmAddressable: true,
  id: 'pa',
  name: 'Personal Assistant',
  role: 'assistant',
  systemManaged: true,
})
const ordinary = agent({ id: 'ordinary', name: 'Ops Bot', role: 'operations' })

const options = (agents: AgentRecord[], query: string, users: UserRecord[] = []) =>
  buildRecipientOptions({
    agents,
    limit: 8,
    query,
    selectedKeys: new Set<string>(),
    users,
  })

test('a member can address a global agent and the Personal Assistant', () => {
  const selected = selectAddressableAgents(
    [ordinary, designer, personalAssistant],
    { isOwner: false },
  )
  assert.deepEqual(selected.map((entry) => entry.id), ['designer', 'pa'])
})

test('ordinary agents keep the owner gate they have always had', () => {
  const asOwner = selectAddressableAgents([ordinary, designer], { isOwner: true })
  assert.deepEqual(asOwner.map((entry) => entry.id), ['ordinary', 'designer'])
})

test('a system agent with no per-person home is not offered', () => {
  // No `dmAddressable`: the server did not claim it resolves to a home DM, so
  // the picker must not offer an option the route would refuse.
  const homeless = agent({ id: 'homeless', name: 'Homeless', systemManaged: true })
  assert.deepEqual(
    selectAddressableAgents([homeless], { isOwner: true }).map((entry) => entry.id),
    [],
  )
})

test('the Agent Designer is found by what a person types', () => {
  const agents = selectAddressableAgents([designer, personalAssistant], { isOwner: false })
  for (const query of ['agent', 'des', 'Designer', 'DESIGN']) {
    const labels = options(agents, query).map((entry) => entry.label)
    assert.ok(
      labels.includes('Agent Designer'),
      `typing "${query}" surfaces the Agent Designer`,
    )
  }
  assert.deepEqual(
    options(agents, 'personal').map((entry) => entry.label),
    ['Personal Assistant'],
  )
})

test('an empty query lists everyone addressable', () => {
  const user = {
    displayName: 'Ondrej',
    email: 'ondrej@test.local',
    id: 'user-1',
  } as UserRecord
  const listed = options(
    selectAddressableAgents([designer], { isOwner: false }),
    '',
    [user],
  )
  assert.deepEqual(listed.map((entry) => entry.kind), ['user', 'agent'])
  assert.deepEqual(listed.map((entry) => entry.detail), ['ondrej@test.local', 'agent designer'])
  assert.deepEqual(listed.map((entry) => entry.category), ['person', 'team agent'])
})

test('same-named agents are distinguished by visibility', () => {
  const teamAgent = agent({
    id: 'team-summary',
    name: 'Web summary',
    role: 'website summarizer',
    visibility: 'team',
  })
  const privateAgent = agent({
    id: 'private-summary',
    name: 'Web summary',
    role: 'website summarizer',
    visibility: 'private',
  })

  const listed = options([teamAgent, privateAgent], '')
  assert.deepEqual(listed.map((entry) => entry.category), ['team agent', 'private agent'])
  assert.deepEqual(
    options([teamAgent, privateAgent], 'private').map((entry) => entry.id),
    ['private-summary'],
  )
})
