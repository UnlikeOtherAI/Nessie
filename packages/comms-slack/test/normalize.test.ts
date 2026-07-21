import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeSlackMessage, slackTsToIso } from '../src/normalize.js'

const TEAM = 'T123'
const CHANNEL = 'C456'

test('normalizes a plain channel message with canonical id + metadata', () => {
  const event = normalizeSlackMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    convType: 'public_channel',
    message: {
      type: 'message',
      ts: '1721550000.000100',
      user: 'U1',
      text: 'Where is the <@U2> deployment doc?',
      files: [
        { id: 'F1', name: 'doc.pdf', mimetype: 'application/pdf', size: 42, url_private: 'https://files/x' },
      ],
      reactions: [{ name: 'eyes', count: 2, users: ['U2', 'U3'] }],
    },
  })

  assert.equal(event.canonicalMessageId, 'slack:T123:C456:1721550000.000100')
  assert.equal(event.messageId, '1721550000.000100')
  assert.equal(event.eventType, 'message.created')
  assert.equal(event.isDeleted, false)
  assert.equal(event.visibility, 'public-channel')
  assert.equal(event.senderExternalId, 'U1')
  assert.equal(event.contentText, 'Where is the <@U2> deployment doc?')
  assert.deepEqual(event.mentions, [{ externalId: 'U2' }])
  // Attachments are metadata only — no bytes fetched.
  assert.deepEqual(event.attachments, [
    { externalId: 'F1', name: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 42, url: 'https://files/x' },
  ])
  assert.deepEqual(event.reactions, [
    { key: 'eyes', count: 2, userExternalIds: ['U2', 'U3'] },
  ])
  assert.equal(event.occurredAt, slackTsToIso('1721550000.000100'))
})

test('normalizes an edited message as message.updated with editedAt', () => {
  const event = normalizeSlackMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    convType: 'private_channel',
    message: {
      type: 'message',
      ts: '1721550000.000200',
      user: 'U1',
      text: 'edited text',
      edited: { user: 'U1', ts: '1721550100.000000' },
    },
  })

  assert.equal(event.eventType, 'message.updated')
  assert.equal(event.editedAt, slackTsToIso('1721550100.000000'))
  assert.equal(event.visibility, 'private-channel')
})

test('normalizes a deleted message as an isDeleted tombstone', () => {
  const event = normalizeSlackMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    convType: 'im',
    message: {},
    messageTs: '1721550000.000300',
    isDeleted: true,
  })

  assert.equal(event.eventType, 'message.deleted')
  assert.equal(event.isDeleted, true)
  assert.equal(event.messageId, '1721550000.000300')
  assert.equal(event.visibility, 'direct-message')
  assert.deepEqual(event.attachments, [])
  assert.deepEqual(event.reactions, [])
})

test('normalizes a thread reply and preserves threadId', () => {
  const event = normalizeSlackMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    convType: 'public_channel',
    message: {
      type: 'message',
      ts: '1721550000.000500',
      thread_ts: '1721550000.000100',
      user: 'U9',
      text: 'reply body',
    },
  })

  assert.equal(event.threadId, '1721550000.000100')
  assert.equal(event.messageId, '1721550000.000500')
  assert.equal(event.canonicalMessageId, 'slack:T123:C456:1721550000.000500')
})
