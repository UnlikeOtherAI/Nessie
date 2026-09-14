import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePushDispatch } from '../src/control/push-dispatch.js'
import {
  ENCRYPTION_KEY_RING,
  apnsCred,
  apnsSecret,
  makeFakePrisma,
  member,
  payload,
  recordingSenders,
} from './push-dispatch-test-support.js'

test('excludes members who muted the channel', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2'), member('u3', true)],
    tokens: [
      { id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' },
      { id: 't3', userId: 'u3', token: 'tok-u3', platform: 'ios' },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )

  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((c) => c.token), ['tok-u2'])
})

test('excludes users currently inside quiet hours', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2'), member('u3')],
    users: [
      { id: 'u2', preferences: null },
      {
        id: 'u3',
        preferences: {
          pushQuietHours: { start: '09:00', end: '10:00', timezone: 'America/New_York' },
        },
      },
    ],
    tokens: [
      { id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' },
      { id: 't3', userId: 'u3', token: 'tok-u3', platform: 'ios' },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    {
      prisma: makeFakePrisma(state),
      encryptionKeyRing: ENCRYPTION_KEY_RING,
      senders,
      now: () => new Date('2026-06-07T13:30:00.000Z'),
    },
    payload(),
  )

  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((c) => c.token), ['tok-u2'])
})

test('excludes users with push disabled', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2'), member('u3')],
    users: [
      { id: 'u2', preferences: null },
      { id: 'u3', preferences: { pushEnabled: false } },
    ],
    tokens: [
      { id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' },
      { id: 't3', userId: 'u3', token: 'tok-u3', platform: 'ios' },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )

  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((c) => c.token), ['tok-u2'])
})

test('notifies users outside quiet hours', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2')],
    users: [
      {
        id: 'u2',
        preferences: {
          pushQuietHours: { start: '09:00', end: '10:00', timezone: 'America/New_York' },
        },
      },
    ],
    tokens: [{ id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' }],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    {
      prisma: makeFakePrisma(state),
      encryptionKeyRing: ENCRYPTION_KEY_RING,
      senders,
      now: () => new Date('2026-06-07T15:30:00.000Z'),
    },
    payload(),
  )

  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((c) => c.token), ['tok-u2'])
})

test('message recipients receive sender-first framing with channel context', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2'), member('u3')],
    users: [
      { id: 'u2', preferences: null },
      { id: 'u3', preferences: null },
      { id: 'author-1', preferences: null, displayName: 'Ada Author' },
    ],
    tokens: [
      { id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' },
      { id: 't3', userId: 'u3', token: 'tok-u3', platform: 'ios' },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls, apnsPayloads } = recordingSenders()
  const dispatchPayload = payload({ mentionUserIds: ['u2'] })
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    dispatchPayload,
  )

  assert.equal(summary.sent, 2)
  const mentionedIdx = apnsCalls.findIndex((call) => call.token === 'tok-u2')
  const unmentionedIdx = apnsCalls.findIndex((call) => call.token === 'tok-u3')
  assert.ok(mentionedIdx >= 0 && unmentionedIdx >= 0)
  assert.equal(apnsPayloads[mentionedIdx]?.title, 'Ada Author')
  assert.equal(apnsPayloads[unmentionedIdx]?.title, 'Ada Author')
  assert.equal(apnsPayloads[mentionedIdx]?.subtitle, 'mentioned you in # General')
  assert.equal(apnsPayloads[unmentionedIdx]?.subtitle, '# General')
  // Both groups retain the exact conversation target and coalescing key.
  assert.equal(apnsPayloads[mentionedIdx]?.collapseId, 'thread-1')
  assert.deepEqual(apnsPayloads[mentionedIdx]?.data, apnsPayloads[unmentionedIdx]?.data)
  assert.equal(
    apnsPayloads[mentionedIdx]?.data?.url,
    '/channels/channel-1/threads/thread-1/replies/message-1',
  )
})

test('a muted member receives no push even when mentioned', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2', true), member('u3')],
    users: [
      { id: 'u2', preferences: null },
      { id: 'u3', preferences: null },
      { id: 'author-1', preferences: null, displayName: 'Ada Author' },
    ],
    tokens: [
      { id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' },
      { id: 't3', userId: 'u3', token: 'tok-u3', platform: 'ios' },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls, apnsPayloads } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({ mentionUserIds: ['u2'] }),
  )

  // The muted mentioned member is suppressed; the alert row + bell badge are
  // still created API-side (covered by the api alert tests).
  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((call) => call.token), ['tok-u3'])
  assert.equal(apnsPayloads[0]?.title, 'Ada Author')
  assert.equal(apnsPayloads[0]?.subtitle, '# General')
})
