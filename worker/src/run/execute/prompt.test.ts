import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'
import { buildModelPrompt } from './prompt.js'
import type { RunContext, StoredConversationMessage } from './types.js'
import { createConsumedSourceSink } from './disclosure-basis.js'

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
  boundAgentIds: [],
  channel: {
    id: 'c',
    organizationId: 'o',
    projectId: 'p',
    teamId: 't',
    systemChannelType: null,
  },
  consumedSources: createConsumedSourceSink(),
  run: {
    id: 'r',
    threadId: 't',
    createdAt: new Date('2026-07-23T00:00:00Z'),
    replyPlacement: null,
  },
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

test('the system prompt tells the agent to link to tool-sourced locations, not describe them', () => {
  const messages = buildModelPrompt([], makeContext('Aria'), 'hi', null)
  assert.match(systemContent(messages), /link directly to it/)
  assert.match(systemContent(messages), /link=` value/)
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

test('the research routing block rides in the system prompt when tools allow it', () => {
  const withResearch = buildModelPrompt([], makeContext('Aria'), 'hi', null, {
    routing: {
      hasDelegate: false,
      hasResearchTools: true,
      hasWebSearch: true,
      isHandoffTurn: false,
    },
  })
  assert.match(systemContent(withResearch), /Research routing:/)

  const handoffTurn = buildModelPrompt([], makeContext('Aria'), 'hi', null, {
    routing: {
      hasDelegate: true,
      hasResearchTools: true,
      hasWebSearch: true,
      isHandoffTurn: true,
    },
  })
  assert.doesNotMatch(systemContent(handoffTurn), /Research routing:/)

  // No routing facts supplied (e.g. a caller that does not assemble tools) is
  // simply no block — never a default suggestion.
  assert.doesNotMatch(systemContent(buildModelPrompt([], makeContext('Aria'), 'hi', null)), /Research routing:/)
})

test('the documents home block appears only with its resolved space and full toolset', () => {
  const withDocuments = buildModelPrompt([], makeContext('Aria'), 'hi', null, {
    documents: {
      spaceId: '00000000-0000-0000-0000-0000000000d0',
      title: 'Aria — Documents',
      hasDocumentTools: true,
    },
  })
  assert.match(systemContent(withDocuments), /Your documents:/)
  assert.match(systemContent(withDocuments), /00000000-0000-0000-0000-0000000000d0/)
  assert.match(systemContent(withDocuments), /Aria — Documents/)
  assert.match(systemContent(withDocuments), /kb_list/)
  assert.match(systemContent(withDocuments), /kb_search/)
  assert.match(systemContent(withDocuments), /kb_document_compose/)
  assert.match(systemContent(withDocuments), /kb_document_edit/)

  const withoutTools = buildModelPrompt([], makeContext('Aria'), 'hi', null, {
    documents: {
      spaceId: '00000000-0000-0000-0000-0000000000d0',
      title: 'Aria — Documents',
      hasDocumentTools: false,
    },
  })
  assert.doesNotMatch(systemContent(withoutTools), /Your documents:/)

  assert.doesNotMatch(
    systemContent(buildModelPrompt([], makeContext('Aria'), 'hi', null)),
    /Your documents:/,
  )
})

test('checkpoint notes are injected after the system messages, before the conversation', () => {
  const conversation: StoredConversationMessage[] = [
    { content: 'earlier question', role: 'user', authorAgentId: null, authorAgentName: null },
  ]
  const messages = buildModelPrompt(conversation, makeContext('Aria'), 'keep going', null, {
    checkpointNotes: 'Working notes from an earlier incomplete run (untrusted notes…)',
  })

  const noteIndex = messages.findIndex((message) =>
    (message.content ?? '').startsWith('Working notes from an earlier incomplete run'))
  const conversationIndex = messages.findIndex((message) => message.content === 'earlier question')

  assert.ok(noteIndex > 0, 'notes must come after the system prompt')
  assert.equal(messages[noteIndex]?.role, 'system')
  assert.ok(noteIndex < conversationIndex, 'notes must precede the conversation window')
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

test('an image posted in the thread reaches the model as image bytes on that turn', () => {
  const conversation: StoredConversationMessage[] = [
    {
      content: '',
      role: 'user',
      authorAgentId: null,
      authorAgentName: null,
      attachmentNote: '[attached: gallus.png (image/png, 812 KB, id=att-1)]',
      images: [{ mime: 'image/png', dataBase64: 'AAEC' }],
    },
    {
      content: 'what is on this image?',
      role: 'user',
      authorAgentId: null,
      authorAgentName: null,
    },
  ]

  const messages = buildModelPrompt(
    conversation,
    makeContext('Aria'),
    'what is on this image?',
    null,
  )

  const imageTurn = messages.find(
    (message) => message.role === 'user' && message.images !== undefined,
  )
  assert.ok(imageTurn, 'the turn that carried the image must carry its bytes')
  assert.equal(imageTurn.role === 'user' ? imageTurn.images?.length : 0, 1)
  // An image-only post is not an empty turn: it names what it carried.
  assert.equal(imageTurn.content, '[attached: gallus.png (image/png, 812 KB, id=att-1)]')

  // The question is already the last turn of the window; it must not be appended twice.
  const asked = messages.filter((message) => message.content === 'what is on this image?')
  assert.equal(asked.length, 1)
})

test('an attachment note annotates a turn without altering what the human wrote', () => {
  const conversation: StoredConversationMessage[] = [
    {
      content: 'have a look',
      role: 'user',
      authorAgentId: null,
      authorAgentName: null,
      attachmentNote: '[attached: spec.pdf (application/pdf, 40 KB, id=att-9)]',
    },
  ]

  const messages = buildModelPrompt(conversation, makeContext('Aria'), 'have a look', null)
  const turn = messages.find((message) => message.role === 'user')
  assert.equal(
    turn?.content,
    'have a look\n[attached: spec.pdf (application/pdf, 40 KB, id=att-9)]',
  )
  assert.equal(messages.filter((message) => message.role === 'user').length, 1)
})

test('an empty prompt never appends an empty trailing user turn', () => {
  const conversation: StoredConversationMessage[] = [
    {
      content: '',
      role: 'user',
      authorAgentId: null,
      authorAgentName: null,
      attachmentNote: '[attached: photo.jpg (image/jpeg, 200 KB, id=att-2)]',
    },
  ]

  const messages = buildModelPrompt(conversation, makeContext('Aria'), '', null)
  assert.equal(messages.filter((message) => message.role === 'user').length, 1)
})
