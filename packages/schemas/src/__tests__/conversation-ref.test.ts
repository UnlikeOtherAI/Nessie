import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONVERSATION_REF_SCHEMA_VERSION,
  ConversationRefMetadataSchema,
  readConversationRef,
} from '../conversation-ref.js'
import { StartAgentConversationBodySchema } from '../agent-conversations.js'

const THREAD = '11111111-1111-4111-8111-111111111111'
const CHANNEL = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'

const doorway = {
  schemaVersion: CONVERSATION_REF_SCHEMA_VERSION,
  threadId: THREAD,
  channelId: CHANNEL,
  agentId: AGENT,
}

test('a doorway carries exactly three ids and its version', () => {
  assert.equal(ConversationRefMetadataSchema.safeParse(doorway).success, true)
  // Strict: a status written into the doorway would be a snapshot that lies
  // within a minute, so the schema refuses one rather than rendering it.
  assert.equal(
    ConversationRefMetadataSchema.safeParse({ ...doorway, status: 'running' }).success,
    false,
  )
  assert.equal(
    ConversationRefMetadataSchema.safeParse({ ...doorway, schemaVersion: 2 }).success,
    false,
  )
})

test('reading a doorway off message metadata never throws', () => {
  assert.deepEqual(readConversationRef({ conversationRef: doorway }), doorway)
  for (const metadata of [
    null,
    undefined,
    'nonsense',
    [],
    {},
    { conversationRef: null },
    { conversationRef: { threadId: THREAD } },
    { conversationRef: { ...doorway, threadId: 'not-a-uuid' } },
  ]) {
    assert.equal(readConversationRef(metadata), null)
  }
})

test('the start body is strict, and an explicit null is not "omitted"', () => {
  assert.equal(StartAgentConversationBodySchema.safeParse({}).success, true)
  assert.equal(
    StartAgentConversationBodySchema.safeParse({ channelId: CHANNEL, message: 'hello' }).success,
    true,
  )
  assert.equal(StartAgentConversationBodySchema.safeParse({ agentId: AGENT }).success, false)
  // `.strict().optional()` rejects null — a client that means "no title" omits
  // the key rather than sending one.
  assert.equal(StartAgentConversationBodySchema.safeParse({ title: null }).success, false)
  assert.equal(StartAgentConversationBodySchema.safeParse({ message: '   ' }).success, false)
})
