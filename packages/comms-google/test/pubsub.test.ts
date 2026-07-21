import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decodePubSubNotification,
  GmailPubSubDecodeError,
} from '../src/pubsub.js'

const pushEnvelope = (inner: unknown): unknown => ({
  message: {
    data: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64'),
    messageId: 'PUBSUB_1',
  },
  subscription: 'projects/p/subscriptions/s',
})

test('decodes a Gmail Pub/Sub push into { emailAddress, historyId }', () => {
  const request = {
    headers: {},
    body: pushEnvelope({ emailAddress: 'me@example.com', historyId: 987654 }),
  }
  const decoded = decodePubSubNotification(request)
  assert.equal(decoded.emailAddress, 'me@example.com')
  assert.equal(decoded.historyId, '987654')
  assert.equal(decoded.messageId, 'PUBSUB_1')
  assert.equal(decoded.subscription, 'projects/p/subscriptions/s')
})

test('rejects an envelope without message.data', () => {
  assert.throws(
    () => decodePubSubNotification({ headers: {}, body: { message: {} } }),
    GmailPubSubDecodeError,
  )
})

test('rejects data that is not base64 JSON', () => {
  assert.throws(
    () =>
      decodePubSubNotification({
        headers: {},
        body: { message: { data: 'not-base64-json!!!' } },
      }),
    GmailPubSubDecodeError,
  )
})

test('rejects a payload missing emailAddress', () => {
  assert.throws(
    () =>
      decodePubSubNotification({ headers: {}, body: pushEnvelope({ historyId: 1 }) }),
    GmailPubSubDecodeError,
  )
})
