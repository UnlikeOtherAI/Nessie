import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONVERSATION_REF_SCHEMA_VERSION,
  readConversationRef,
  type AgentConversationRecord,
} from '@nessie/schemas'

import { conversationPath } from '../src/components/features/agents/conversations/AgentConversationList'
import {
  conversationRoomEyebrow,
  conversationRoomLabel,
  formatConversationTime,
} from '../src/components/features/agents/conversations/conversation-presentation'
import {
  conversationBodyLine,
  conversationStatus,
} from '../src/components/features/agents/conversations/conversation-status'
import {
  focusComposerState,
  readFocusComposerIntent,
} from '../src/components/features/agents/conversations/conversation-intent'

/**
 * The pure half of agent conversations
 * (docs/plans/2026-09-08-agent-conversations.md).
 *
 * Everything a card or a list row says about a conversation is decided from
 * the record alone — never composed from what was said in it, never inferred.
 * These are the functions that make that checkable rather than asserted.
 */

const uuid = (tail: string): string => `00000000-0000-4000-8000-00000000${tail}`

const record = (overrides: Partial<AgentConversationRecord> = {}): AgentConversationRecord => ({
  activeRun: null,
  agentId: uuid('0002'),
  channel: {
    id: uuid('0003'),
    label: 'design',
    projectName: 'Website',
    systemChannelType: null,
    type: 'standard',
  },
  createdAt: '2026-09-01T10:00:00.000Z',
  id: uuid('0001'),
  isGeneral: false,
  lastActivityAt: '2026-09-08T10:00:00.000Z',
  lastMessagePreview: 'Have a look at the pricing page',
  lastRunOutcome: null,
  startedByUserId: null,
  title: 'Pricing page copy',
  unreadCount: 0,
  ...overrides,
} as AgentConversationRecord)

const run = (
  status: 'pending' | 'running' | 'waiting_approval' | 'waiting_input',
  progressLine: string | null = null,
): AgentConversationRecord['activeRun'] => ({
  id: uuid('0009'),
  progressLine,
  startedAt: '2026-09-08T09:59:00.000Z',
  status,
}) as AgentConversationRecord['activeRun']

describe('conversation status', () => {
  it('maps every run status the record can state', () => {
    assert.deepEqual(conversationStatus(record({ activeRun: run('running') })), {
      dot: 'success',
      label: 'Running',
      tone: 'success',
    })
    assert.deepEqual(conversationStatus(record({ activeRun: run('pending') })), {
      dot: 'muted',
      label: 'Queued',
      tone: 'muted',
    })
    assert.equal(
      conversationStatus(record({ activeRun: run('waiting_approval') })).label,
      'Waiting for approval',
    )
    assert.equal(conversationStatus(record({ activeRun: run('waiting_approval') })).tone, 'warning')
    assert.equal(
      conversationStatus(record({ activeRun: run('waiting_input') })).label,
      'Needs a reply',
    )
    assert.equal(conversationStatus(record({ activeRun: run('waiting_input') })).tone, 'warning')
  })

  it('says how the last run ended once the live one is gone', () => {
    assert.equal(conversationStatus(record({ lastRunOutcome: 'completed' })).label, 'Done')
    assert.equal(conversationStatus(record({ lastRunOutcome: 'failed' })).label, 'Failed')
    assert.equal(conversationStatus(record({ lastRunOutcome: 'failed' })).tone, 'danger')
    assert.equal(conversationStatus(record({ lastRunOutcome: 'cancelled' })).label, 'Cancelled')
    // A conversation opened empty from the rail: the ordinary state, not an error.
    assert.equal(conversationStatus(record()).label, 'Not started')
  })

  it('an active run outranks the outcome of the last one', () => {
    // Otherwise a second run in a conversation that already failed once would
    // read "Failed" while it is visibly running.
    const restarted = record({ activeRun: run('running'), lastRunOutcome: 'failed' })
    assert.equal(conversationStatus(restarted).label, 'Running')
  })

  it('shows what it is doing now while it runs, and what was said otherwise', () => {
    assert.equal(
      conversationBodyLine(record({ activeRun: run('running', 'Reading the pricing page') })),
      'Reading the pricing page',
    )
    // A run with nothing written yet falls through to the newest message
    // rather than showing an empty line.
    assert.equal(
      conversationBodyLine(record({ activeRun: run('running') })),
      'Have a look at the pricing page',
    )
    assert.equal(conversationBodyLine(record()), 'Have a look at the pricing page')
    assert.equal(
      conversationBodyLine(record({ activeRun: null, lastMessagePreview: null })),
      'Nothing said yet',
    )
    // The list says the empty case in its own words; the precedence is shared.
    assert.equal(
      conversationBodyLine(record({ lastMessagePreview: null }), 'No messages yet'),
      'No messages yet',
    )
  })
})

describe('conversation presentation', () => {
  it('names the room the way the reader already does', () => {
    assert.equal(conversationRoomLabel(record().channel), '#design')
    assert.equal(
      conversationRoomLabel(record({
        channel: { ...record().channel, label: 'Ada Lovelace', projectName: null, type: 'dm' },
      }).channel),
      'Ada Lovelace',
    )
    assert.equal(
      conversationRoomLabel(record({
        channel: {
          ...record().channel,
          label: 'pa:org:user',
          projectName: null,
          systemChannelType: 'personal_assistant',
          type: 'dm',
        },
      }).channel),
      'Personal Assistant',
    )
  })

  it('the eyebrow adds the project, and a DM has none to add', () => {
    assert.equal(conversationRoomEyebrow(record().channel), '#design · Website')
    assert.equal(
      conversationRoomEyebrow(record({
        channel: { ...record().channel, projectName: null },
      }).channel),
      '#design',
    )
  })

  it('reads an age the way an inbox does: now, minutes, hours, weekday, date', () => {
    const now = Date.parse('2026-09-08T12:00:00.000Z')
    const at = (iso: string) => formatConversationTime(iso, now)
    assert.equal(at('2026-09-08T11:59:30.000Z'), 'now')
    assert.equal(at('2026-09-08T11:56:00.000Z'), '4m')
    assert.equal(at('2026-09-08T10:00:00.000Z'), '2h')
    // Inside the last week: the weekday, in the reader's own local calendar.
    const within = new Date('2026-09-02T12:00:00.000Z')
    assert.equal(
      at('2026-09-02T12:00:00.000Z'),
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][within.getDay()],
    )
    // Exactly a week old is already a date: the weekday would be this weekday,
    // which reads as today.
    assert.equal(at('2026-09-01T12:00:00.000Z'), `${new Date('2026-09-01T12:00:00.000Z').getDate()} Sep`)
    const older = new Date('2026-08-03T12:00:00.000Z')
    assert.equal(at('2026-08-03T12:00:00.000Z'), `${older.getDate()} Aug`)
  })

  it('never fabricates an age', () => {
    assert.equal(formatConversationTime(null), null)
    assert.equal(formatConversationTime(undefined), null)
    assert.equal(formatConversationTime('not a date'), null)
    // A timestamp ahead of this clock is "now", never a negative age.
    const now = Date.parse('2026-09-08T12:00:00.000Z')
    assert.equal(formatConversationTime('2026-09-08T12:00:30.000Z', now), 'now')
  })
})

describe('the conversation doorway', () => {
  it('one spelling of the route, for the list, the panel and the card', () => {
    assert.equal(
      conversationPath(record()),
      `/channels/${uuid('0003')}/threads/${uuid('0001')}`,
    )
  })

  it('renders nothing at all for metadata that is not a doorway', () => {
    // The card is dispatched from every message in the feed, so anything that
    // is not exactly this shape must read as "no card" rather than throw.
    assert.equal(readConversationRef(undefined), null)
    assert.equal(readConversationRef(null), null)
    assert.equal(readConversationRef({}), null)
    assert.equal(readConversationRef({ conversationRef: 'nonsense' }), null)
    assert.equal(readConversationRef({ conversationRef: { threadId: uuid('0001') } }), null)
    assert.equal(
      readConversationRef({
        conversationRef: {
          agentId: uuid('0002'),
          channelId: uuid('0003'),
          schemaVersion: 99,
          threadId: uuid('0001'),
        },
      }),
      null,
    )
  })

  it('reads a server-written doorway', () => {
    const doorway = readConversationRef({
      conversationRef: {
        agentId: uuid('0002'),
        channelId: uuid('0003'),
        schemaVersion: CONVERSATION_REF_SCHEMA_VERSION,
        threadId: uuid('0001'),
      },
    })
    assert.equal(doorway?.threadId, uuid('0001'))
    assert.equal(doorway?.channelId, uuid('0003'))
  })
})

describe('arriving in a new conversation', () => {
  it('the composer intent is written and read through one pair', () => {
    assert.equal(readFocusComposerIntent(focusComposerState()), true)
    assert.equal(readFocusComposerIntent(null), false)
    assert.equal(readFocusComposerIntent(undefined), false)
    assert.equal(readFocusComposerIntent({ focusComposer: 'yes' }), false)
    assert.equal(readFocusComposerIntent([{ focusComposer: true }]), false)
    // An ordinary navigation entry's state — a compose return address — is not
    // an instruction to steal the caret.
    assert.equal(readFocusComposerIntent({ returnTo: '/channels/x' }), false)
  })
})
