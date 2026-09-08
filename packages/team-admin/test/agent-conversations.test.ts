import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAgentConversationWhere,
  buildViewerThreadWhere,
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
} from '../src/agent-conversations.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'

// The predicate and the title rule are pure, and both are the kind of thing a
// database test would prove slowly and vaguely. What matters here is their
// exact shape: `findThreadForUser`, the conversation list, the start door and
// the `conversation_reference` tool all compose these, so a silent change to
// either widens or narrows four surfaces at once.

test('buildViewerThreadWhere is the room-is-the-audience predicate, and nothing more', () => {
  assert.deepEqual(buildViewerThreadWhere(USER, ORG), {
    channel: {
      organizationId: ORG,
      OR: [
        { visibility: 'public' },
        { members: { some: { userId: USER } } },
      ],
    },
  })
})

test('the agent list is the viewer predicate AND one of the two arms', () => {
  const where = buildAgentConversationWhere({
    agentId: AGENT,
    organizationId: ORG,
    userId: USER,
  })

  // The viewer predicate survives as a top-level field, which is what ANDs it
  // with the OR rather than letting either arm escape it.
  assert.deepEqual(where.channel, buildViewerThreadWhere(USER, ORG).channel)
  assert.deepEqual(where.OR, [
    { agentId: AGENT },
    {
      agentId: null,
      channel: {
        agentBindings: {
          some: {
            agentId: AGENT,
            // Somebody else's assistant presence in a shared room is not this
            // person's conversation, and must not appear in their list.
            OR: [{ principalUserId: null }, { principalUserId: USER }],
          },
        },
      },
    },
  ])
})

test('another person cannot be substituted into the presence clause', () => {
  const where = buildAgentConversationWhere({
    agentId: AGENT,
    organizationId: ORG,
    userId: USER,
  })
  assert.ok(!JSON.stringify(where).includes(OTHER_USER))
})

test('a caller-supplied title wins, trimmed', () => {
  assert.equal(
    deriveConversationTitle({ message: 'ignored', title: '  Q3 pricing  ' }),
    'Q3 pricing',
  )
})

test('a title falls back to the first non-empty line of the opening message', () => {
  assert.equal(
    deriveConversationTitle({ message: '\n\n  Draft   the   brief \nand then send it' }),
    'Draft the brief',
  )
})

test('a derived title is bounded, with the elision visible', () => {
  const title = deriveConversationTitle({ message: 'x'.repeat(200) })
  assert.equal(title.length, 80)
  assert.ok(title.endsWith('…'))
})

test('a conversation opened with neither a title nor a message is still named', () => {
  assert.equal(deriveConversationTitle({}), DEFAULT_CONVERSATION_TITLE)
  assert.equal(
    deriveConversationTitle({ message: '   \n  ', title: '   ' }),
    DEFAULT_CONVERSATION_TITLE,
  )
})
