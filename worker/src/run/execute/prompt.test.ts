import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import { buildModelPrompt } from './prompt.js'
import type { RunContext, StoredConversationMessage } from './types.js'

const ACTING_AGENT_ID = '00000000-0000-0000-0000-00000000000a'
const OTHER_AGENT_ID = '00000000-0000-0000-0000-00000000000b'

const makeContext = (name: string, id: string = ACTING_AGENT_ID): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id,
    model: null,
    name,
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
  },
  channel: { id: 'c', organizationId: 'o', systemChannelType: null },
  run: { id: 'r', threadId: 't' },
  task: { id: 'task' },
})

const systemContent = (messages: ProviderMessage[]): string => {
  const system = messages.find((message) => message.role === 'system')
  assert.ok(system, 'expected a system message')
  return system.content ?? ''
}

test('acting agent is told its own name in the system prompt', () => {
  const messages = buildModelPrompt([], makeContext('Aria'), 'hi', null)
  assert.match(systemContent(messages), /^You are Aria\./)
})

test('other agents\' turns are name-prefixed; the acting agent\'s own turns are not', () => {
  const conversation: StoredConversationMessage[] = [
    { content: 'What is the status?', role: 'user', authorAgentId: null, authorAgentName: null },
    {
      content: 'I checked the deploy.',
      role: 'assistant',
      authorAgentId: ACTING_AGENT_ID,
      authorAgentName: 'Aria',
    },
    {
      content: 'The migration is still pending.',
      role: 'assistant',
      authorAgentId: OTHER_AGENT_ID,
      authorAgentName: 'Boron',
    },
  ]

  const messages = buildModelPrompt(conversation, makeContext('Aria'), 'follow up', null)

  const ownTurn = messages.find(
    (message) => message.role === 'assistant' && message.content === 'I checked the deploy.',
  )
  assert.ok(ownTurn, 'acting agent\'s own turn should be unprefixed')

  const otherTurn = messages.find(
    (message) =>
      message.role === 'assistant' && message.content === 'Boron: The migration is still pending.',
  )
  assert.ok(otherTurn, 'other agent\'s turn should be prefixed with its name')

  // Shared-thread guidance is included when another agent is present.
  assert.match(systemContent(messages), /prefixed with their name/)
})

test('single-agent thread gets no multi-agent guidance and no prefixes', () => {
  const conversation: StoredConversationMessage[] = [
    { content: 'ping', role: 'user', authorAgentId: null, authorAgentName: null },
    {
      content: 'pong',
      role: 'assistant',
      authorAgentId: ACTING_AGENT_ID,
      authorAgentName: 'Aria',
    },
  ]

  const messages = buildModelPrompt(conversation, makeContext('Aria'), 'again', null)
  assert.doesNotMatch(systemContent(messages), /prefixed with their name/)
  const assistantTurn = messages.find((message) => message.role === 'assistant')
  assert.equal(assistantTurn?.content, 'pong')
})

test('rename is reflected: prefix uses the live author name, not a stale one', () => {
  const conversation: StoredConversationMessage[] = [
    {
      content: 'earlier note',
      role: 'assistant',
      authorAgentId: OTHER_AGENT_ID,
      // Live name resolved via FK join at load time — a rename shows here.
      authorAgentName: 'RenamedAgent',
    },
  ]

  const messages = buildModelPrompt(conversation, makeContext('Aria'), 'x', null)
  const otherTurn = messages.find(
    (message) => message.role === 'assistant' && message.content?.startsWith('RenamedAgent: '),
  )
  assert.ok(otherTurn, 'prefix should use the live (renamed) author name')
})

test('missing author name falls back without dropping the message', () => {
  const conversation: StoredConversationMessage[] = [
    {
      content: 'orphaned turn',
      role: 'assistant',
      authorAgentId: OTHER_AGENT_ID,
      authorAgentName: null,
    },
  ]

  const messages = buildModelPrompt(conversation, makeContext('Aria'), 'x', null)
  const otherTurn = messages.find(
    (message) => message.role === 'assistant' && message.content === 'Another agent: orphaned turn',
  )
  assert.ok(otherTurn, 'unnamed other-agent turn should fall back to a generic label')
})
