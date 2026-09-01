import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'

import type { WebhookRequest } from '@nessie/comms-connect'

import { inspectSlackWebhook } from '../src/webhook.js'

const SECRET = 'signing-secret'
const NOW_MS = 1_721_550_000_000
const TS = String(Math.floor(NOW_MS / 1000))

const signed = (body: unknown): WebhookRequest => {
  const rawBody = JSON.stringify(body)
  const signature = `v0=${crypto
    .createHmac('sha256', SECRET)
    .update(`v0:${TS}:${rawBody}`, 'utf8')
    .digest('hex')}`
  return {
    headers: {
      'x-slack-signature': signature,
      'x-slack-request-timestamp': TS,
    },
    body,
    rawBody,
  }
}

test('answers the url_verification challenge', () => {
  const outcome = inspectSlackWebhook(
    signed({ type: 'url_verification', challenge: 'chal-123' }),
    SECRET,
    NOW_MS,
  )
  assert.deepEqual(outcome, { kind: 'challenge', challenge: 'chal-123' })
})

test('normalizes a plain message event', () => {
  const outcome = inspectSlackWebhook(
    signed({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
      event: {
        type: 'message',
        channel: 'C1',
        channel_type: 'channel',
        ts: '1721550000.000100',
        user: 'U1',
        text: 'hello',
      },
    }),
    SECRET,
    NOW_MS,
  )
  assert.equal(outcome.kind, 'events')
  assert.ok(outcome.kind === 'events')
  assert.equal(outcome.events.length, 1)
  assert.equal(outcome.events[0]?.eventType, 'message.created')
  assert.equal(outcome.events[0]?.visibility, 'public-channel')
})

test('maps message_changed to an updated version', () => {
  const outcome = inspectSlackWebhook(
    signed({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        channel_type: 'group',
        message: {
          ts: '1721550000.000100',
          user: 'U1',
          text: 'edited',
          edited: { user: 'U1', ts: '1721550100.000000' },
        },
      },
    }),
    SECRET,
    NOW_MS,
  )
  assert.ok(outcome.kind === 'events')
  assert.equal(outcome.events[0]?.eventType, 'message.updated')
  assert.equal(outcome.events[0]?.visibility, 'private-channel')
})

test('maps message_deleted to an isDeleted tombstone', () => {
  const outcome = inspectSlackWebhook(
    signed({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'message',
        subtype: 'message_deleted',
        channel: 'C1',
        channel_type: 'channel',
        deleted_ts: '1721550000.000100',
      },
    }),
    SECRET,
    NOW_MS,
  )
  assert.ok(outcome.kind === 'events')
  assert.equal(outcome.events[0]?.isDeleted, true)
  assert.equal(outcome.events[0]?.messageId, '1721550000.000100')
})

test('ignores non-message subtypes', () => {
  const outcome = inspectSlackWebhook(
    signed({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'message',
        subtype: 'channel_join',
        channel: 'C1',
        channel_type: 'channel',
        ts: '1721550000.000100',
      },
    }),
    SECRET,
    NOW_MS,
  )
  assert.deepEqual(outcome, { kind: 'ignored' })
})
