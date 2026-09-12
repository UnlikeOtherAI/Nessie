import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePushDispatch } from '../src/control/push-dispatch.js'
import {
  ENCRYPTION_KEY_RING,
  apnsCred,
  apnsSecret,
  fcmCred,
  fcmSecret,
  makeFakePrisma,
  member,
  payload,
  recordingSenders,
} from './push-dispatch-test-support.js'

test('early-returns when no push credentials are configured', async () => {
  const state: FakeState = {
    creds: [],
    members: [member('u2')],
    tokens: [{ id: 't1', userId: 'u2', token: 'tok', platform: 'ios' }],
    secrets: [],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls, fcmCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )
  assert.deepEqual(summary, { sent: 0, failed: 0, pruned: 0 })
  assert.equal(apnsCalls.length, 0)
  assert.equal(fcmCalls.length, 0)
})

test('skips a push when the recipient is actively viewing its exact thread', async () => {
  const state: FakeState = {
    channel: { label: 'General' },
    creds: [apnsCred()],
    deleted: [],
    members: [member('u2')],
    secrets: [apnsSecret()],
    surfaceViewers: [{ userId: 'u2', kind: 'channel', channelId: 'channel-1', rootMessageId: null, threadId: 'thread-1' }],
    tokens: [{ id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' }],
  }
  const { senders, apnsCalls } = recordingSenders()

  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )

  assert.deepEqual(summary, { sent: 0, failed: 0, pruned: 0 })
  assert.deepEqual(apnsCalls, [])
})

test('delivers to every device when a foreground window is in a different thread', async () => {
  const state: FakeState = {
    channel: { label: 'General' },
    creds: [apnsCred(), fcmCred()],
    deleted: [],
    members: [member('u2')],
    unreadAttentionCount: 2,
    unreadMessageCount: 3,
    secrets: [apnsSecret(), fcmSecret()],
    surfaceViewers: [{ userId: 'u2', kind: 'channel', channelId: 'channel-1', rootMessageId: null, threadId: 'thread-2' }],
    tokens: [
      { id: 'iphone', userId: 'u2', token: 'tok-iphone', platform: 'ios' },
      { id: 'ipad', userId: 'u2', token: 'tok-ipad', platform: 'ios' },
      { id: 'android', userId: 'u2', token: 'tok-android', platform: 'android' },
    ],
  }
  const { apnsCalls, apnsPayloads, fcmCalls, fcmPayloads, senders } = recordingSenders()

  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )

  assert.deepEqual(summary, { sent: 3, failed: 0, pruned: 0 })
  assert.deepEqual(apnsCalls.map((target) => target.token), ['tok-iphone', 'tok-ipad'])
  assert.deepEqual(fcmCalls.map((target) => target.token), ['tok-android'])
  assert.equal(apnsPayloads[0]?.badge, 5)
  assert.equal(apnsPayloads[1]?.badge, 5)
  assert.equal(fcmPayloads[0]?.badge, 5)
  assert.equal(
    apnsPayloads[0]?.data?.url,
    '/channels/channel-1/threads/thread-1/replies/message-1',
  )
})

test('delivers when another reply conversation is open in the same thread container', async () => {
  const state: FakeState = {
    channel: { label: 'General' },
    creds: [apnsCred()],
    deleted: [],
    members: [member('u2')],
    secrets: [apnsSecret()],
    surfaceViewers: [{
      userId: 'u2',
      kind: 'channel',
      channelId: 'channel-1',
      rootMessageId: 'root-a',
      threadId: 'thread-1',
    }],
    tokens: [{ id: 'iphone', userId: 'u2', token: 'tok-iphone', platform: 'ios' }],
  }
  const { apnsCalls, senders } = recordingSenders()

  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({ rootMessageId: 'root-b' }),
  )

  assert.deepEqual(summary, { sent: 1, failed: 0, pruned: 0 })
  assert.deepEqual(apnsCalls.map((target) => target.token), ['tok-iphone'])
})

test('sends an interactive agent reply to its explicit requester', async () => {
  const state: FakeState = {
    channel: { label: 'General' },
    creds: [apnsCred()],
    deleted: [],
    members: [member('asking-user'), member('other-user')],
    secrets: [apnsSecret()],
    tokens: [
      { id: 'asking-token', userId: 'asking-user', token: 'tok-asking', platform: 'ios' },
      { id: 'other-token', userId: 'other-user', token: 'tok-other', platform: 'ios' },
    ],
  }
  const { senders, apnsCalls } = recordingSenders()

  await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({ authorUserId: undefined, recipientUserIds: ['asking-user'] }),
  )

  assert.deepEqual(apnsCalls.map((target) => target.token), ['tok-asking'])
})

test('sends a generic protected reply only when its requester still has access', async () => {
  const state: FakeState = {
    channel: { label: 'General' },
    creds: [apnsCred()],
    deleted: [],
    members: [member('asking-user')],
    message: {
      agent: { name: 'Smith' },
      agentId: 'agent-1',
      basisScopes: [{ scopeId: 'channel-1', scopeType: 'channel' }],
      user: null,
    },
    secrets: [apnsSecret()],
    tokens: [{ id: 'asking-token', userId: 'asking-user', token: 'tok-asking', platform: 'ios' }],
  }
  const { senders, apnsCalls, apnsPayloads } = recordingSenders()

  await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({
      authorUserId: undefined,
      contentSnippet: 'Restricted source text must not reach the lock screen.',
      contentVisibility: 'generic',
      mentionUserIds: [],
      recipientUserIds: ['asking-user'],
    }),
  )

  assert.deepEqual(apnsCalls.map((target) => target.token), ['tok-asking'])
  assert.equal(apnsPayloads[0]?.title, 'Smith')
  assert.equal(apnsPayloads[0]?.subtitle, '# General')
  assert.equal(apnsPayloads[0]?.body, 'An agent reply is ready.')
})

test('withholds a generic protected reply after its source access is revoked', async () => {
  const state: FakeState = {
    channel: { label: 'General' },
    creds: [apnsCred()],
    deleted: [],
    members: [member('asking-user')],
    message: {
      agent: { name: 'Smith' },
      agentId: 'agent-1',
      basisScopes: [{ scopeId: 'project-that-was-revoked', scopeType: 'project' }],
      user: null,
    },
    secrets: [apnsSecret()],
    tokens: [{ id: 'asking-token', userId: 'asking-user', token: 'tok-asking', platform: 'ios' }],
  }
  const { senders, apnsCalls } = recordingSenders()

  await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({
      authorUserId: undefined,
      contentVisibility: 'generic',
      mentionUserIds: [],
      recipientUserIds: ['asking-user'],
    }),
  )

  assert.deepEqual(apnsCalls, [])
})

test('withholds a generic protected reply when its grantor has been deactivated', async () => {
  const state: FakeState = {
    activeOrganizationMemberIds: ['asking-user'],
    channel: { label: 'General' },
    creds: [apnsCred()],
    deleted: [],
    disclosureGrants: [{ grantedByUserId: 'deactivated-grantor' }],
    members: [member('asking-user')],
    message: {
      agent: { name: 'Smith' },
      agentId: 'agent-1',
      basisScopes: [{ scopeId: 'deactivated-grantor', scopeType: 'user' }],
      user: null,
    },
    secrets: [apnsSecret()],
    tokens: [{ id: 'asking-token', userId: 'asking-user', token: 'tok-asking', platform: 'ios' }],
  }
  const { senders, apnsCalls } = recordingSenders()

  await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({
      authorUserId: undefined,
      contentVisibility: 'generic',
      mentionUserIds: [],
      recipientUserIds: ['asking-user'],
    }),
  )

  assert.deepEqual(apnsCalls, [])
})

test('excludes the author and notifies only active organization members', async () => {
  // The handler requires an active organization membership as well as channel
  // membership, so deactivated users cannot receive a retained-channel push.
  let appliedWhere: unknown
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2')],
    tokens: [{ id: 't2', userId: 'u2', token: 'tok-u2', platform: 'ios' }],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const prisma = makeFakePrisma(state)
  prisma.channelMember.findMany = (async (args: { where: unknown }) => {
    appliedWhere = args.where
    return state.members
  }) as typeof prisma.channelMember.findMany
  const { senders, apnsCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma, encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload({ authorUserId: 'author-1' }),
  )
  assert.deepEqual(appliedWhere, {
    channelId: 'channel-1',
    userId: { not: 'author-1' },
    user: {
      organizationMembers: {
        some: { deactivatedAt: null, organizationId: 'org-1' },
      },
    },
  })
  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((c) => c.token), ['tok-u2'])
})

test('only sends to configured-provider tokens', async () => {
  // APNs configured, FCM not. An android token must be skipped, ios delivered.
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2'), member('u3')],
    tokens: [
      { id: 'ios1', userId: 'u2', token: 'ios-tok', platform: 'ios' },
      { id: 'and1', userId: 'u3', token: 'and-tok', platform: 'android' },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls, fcmCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )
  assert.deepEqual(apnsCalls.map((c) => c.token), ['ios-tok'])
  assert.equal(fcmCalls.length, 0)
  assert.equal(summary.sent, 1)
})

test('scopes native device-token delivery to the dispatch organization', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2')],
    tokens: [{ id: 'ios1', userId: 'u2', token: 'ios-tok', platform: 'ios' }],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const prisma = makeFakePrisma(state)
  let deviceWhere: unknown
  prisma.deviceToken.findMany = (async ({ where }: { where: unknown }) => {
    deviceWhere = where
    return state.tokens
  }) as typeof prisma.deviceToken.findMany

  await handlePushDispatch(
    { prisma, encryptionKeyRing: ENCRYPTION_KEY_RING, senders: recordingSenders().senders },
    payload({ organizationId: 'org-push-scope' }),
  )

  assert.deepEqual(deviceWhere, {
    organizationId: 'org-push-scope',
    userId: { in: ['u2'] },
    inactiveAt: null,
  })
})

test('routes ios→apns and android→fcm when both providers configured', async () => {
  const state: FakeState = {
    creds: [apnsCred(), fcmCred()],
    members: [member('u2'), member('u3')],
    tokens: [
      { id: 'ios1', userId: 'u2', token: 'ios-tok', platform: 'ios' },
      { id: 'and1', userId: 'u3', token: 'and-tok', platform: 'android' },
    ],
    secrets: [apnsSecret(), fcmSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCalls, fcmCalls } = recordingSenders()
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )
  assert.deepEqual(apnsCalls.map((c) => c.token), ['ios-tok'])
  assert.deepEqual(fcmCalls.map((c) => c.token), ['and-tok'])
  assert.equal(summary.sent, 2)
})

test('uses the APNs host environment registered by an iOS device', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2')],
    tokens: [
      {
        id: 'ios1',
        userId: 'u2',
        token: 'ios-sandbox-token',
        platform: 'ios',
        apnsEnvironment: 'sandbox',
      },
    ],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, apnsCredentials } = recordingSenders()

  await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )

  assert.equal(apnsCredentials[0]?.environment, 'sandbox')
})

test('a deadToken result prunes that device-token row', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2')],
    tokens: [{ id: 'dead1', userId: 'u2', token: 'dead-tok', platform: 'ios' }],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const { senders, results } = recordingSenders()
  results.set('dead-tok', { ok: false, status: 410, deadToken: true, error: 'Unregistered' })
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )
  assert.equal(summary.failed, 1)
  assert.equal(summary.pruned, 1)
  assert.deepEqual(state.deleted, ['dead1'])
})

test('does not throw or prune when a sender rejects', async () => {
  const state: FakeState = {
    creds: [apnsCred()],
    members: [member('u2')],
    tokens: [{ id: 't1', userId: 'u2', token: 'tok', platform: 'ios' }],
    secrets: [apnsSecret()],
    channel: { label: 'General' },
    deleted: [],
  }
  const senders: PushSenders = {
    sendApns: async () => {
      throw new Error('network down')
    },
    sendFcm: async () => ({ ok: true, status: 200, deadToken: false }),
  }
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders },
    payload(),
  )
  assert.equal(summary.failed, 1)
  assert.equal(summary.sent, 0)
  assert.deepEqual(state.deleted, [])
})
