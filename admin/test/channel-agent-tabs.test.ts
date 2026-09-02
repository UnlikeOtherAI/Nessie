import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRecord } from '../src/lib/api-client'
import {
  CHANNEL_TABS,
  isAgentsTabAvailable,
  isConversationAgentTabAvailable,
  isConversationTriggersTabAvailable,
  isConversationTodosTabAvailable,
  resolveConversationAgent,
} from '../src/components/features/channels/channel-helpers'

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  channelIds: [],
  id: 'agent-1',
  lastActivityAt: new Date(0).toISOString(),
  name: 'KiloResearcher',
  role: 'Research assistant',
  status: 'idle',
  systemManaged: false,
  todosEnabled: false,
  ...overrides,
} as AgentRecord)

const conversation = {
  boundAgents: [] as AgentRecord[],
  isConversationSurface: true,
  isPersonalAssistantConversation: false,
  personalAssistantAgent: null as AgentRecord | null,
}

test('the sections a conversation can show include the agent-shaped ones', () => {
  for (const tab of ['agent', 'to-dos', 'triggers'] as const) {
    assert.ok(CHANNEL_TABS.includes(tab), `${tab} must be a validated ?tab= value`)
  }
})

test('a channel has no conversation agent, so it never shows an agent section', () => {
  const conversationAgent = resolveConversationAgent({
    ...conversation,
    boundAgents: [agent({ todosEnabled: true })],
    isConversationSurface: false,
  })
  assert.equal(conversationAgent, null)
  assert.equal(isConversationAgentTabAvailable(conversationAgent), false)
  assert.equal(isConversationTodosTabAvailable(conversationAgent), false)
  assert.equal(isConversationTriggersTabAvailable({ conversationAgent, isOwner: true }), false)
  // …and it keeps its roster.
  assert.equal(
    isAgentsTabAvailable({
      boundAgentCount: 1,
      conversationAgent,
      isConversationSurface: false,
      isPersonalAssistantConversation: false,
    }),
    true,
  )
})

test('a DM with one agent shows that agent, and drops the roster of one', () => {
  const conversationAgent = resolveConversationAgent({
    ...conversation,
    boundAgents: [agent({ todosEnabled: true })],
  })
  assert.equal(conversationAgent?.id, 'agent-1')
  assert.equal(isConversationAgentTabAvailable(conversationAgent), true)
  assert.equal(isConversationTodosTabAvailable(conversationAgent), true)
  assert.equal(
    isAgentsTabAvailable({
      boundAgentCount: 1,
      conversationAgent,
      isConversationSurface: true,
      isPersonalAssistantConversation: false,
    }),
    false,
  )
})

test('to-dos follow the agent’s own switch, not the fact that it is an agent', () => {
  const conversationAgent = resolveConversationAgent({
    ...conversation,
    boundAgents: [agent({ todosEnabled: false })],
  })
  assert.equal(isConversationAgentTabAvailable(conversationAgent), true)
  assert.equal(isConversationTodosTabAvailable(conversationAgent), false)
})

test('triggers are owner-only, because the trigger read is', () => {
  const conversationAgent = resolveConversationAgent({
    ...conversation,
    boundAgents: [agent()],
  })
  assert.equal(isConversationTriggersTabAvailable({ conversationAgent, isOwner: true }), true)
  assert.equal(isConversationTriggersTabAvailable({ conversationAgent, isOwner: false }), false)
})

test('a group conversation carrying two agents has no single subject', () => {
  const conversationAgent = resolveConversationAgent({
    ...conversation,
    boundAgents: [agent(), agent({ id: 'agent-2', name: 'Second' })],
  })
  assert.equal(conversationAgent, null)
  // It falls back to the roster, which is what a two-agent room needs.
  assert.equal(
    isAgentsTabAvailable({
      boundAgentCount: 2,
      conversationAgent,
      isConversationSurface: true,
      isPersonalAssistantConversation: false,
    }),
    true,
  )
})

test('the Personal Assistant DM is its agent, and never flashes a roster first', () => {
  const pa = agent({ id: 'pa', name: 'Personal Assistant', systemManaged: true })
  assert.equal(
    resolveConversationAgent({
      ...conversation,
      isPersonalAssistantConversation: true,
      personalAssistantAgent: pa,
    })?.id,
    'pa',
  )
  // Before its own read lands there is no agent yet — and still no roster,
  // even though a presence row would otherwise satisfy the roster's own test.
  assert.equal(
    isAgentsTabAvailable({
      boundAgentCount: 0,
      conversationAgent: null,
      isConversationSurface: true,
      isPersonalAssistantConversation: true,
      personalAssistantPresenceCount: 1,
    }),
    false,
  )
})

test('a person-to-person DM shows neither an agent section nor a roster', () => {
  const conversationAgent = resolveConversationAgent(conversation)
  assert.equal(isConversationAgentTabAvailable(conversationAgent), false)
  assert.equal(
    isAgentsTabAvailable({
      boundAgentCount: 0,
      conversationAgent,
      isConversationSurface: true,
      isPersonalAssistantConversation: false,
    }),
    false,
  )
})
