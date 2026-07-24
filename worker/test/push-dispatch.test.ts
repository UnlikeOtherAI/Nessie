import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import type { PushPayload, PushResult, PushTarget } from '@nessie/push'
import {
  handlePushDispatch,
  type PushDispatchPrisma,
  type PushSenders,
} from '../src/control/push-dispatch.js'
import type {
  ApnsCredentials,
  FcmCredentials,
} from '@nessie/push'

const AUTH_SECRET = 'test-auth-secret'

type CredRow = {
  provider: 'apns' | 'fcm'
  secretRef: string
  apnsKeyId: string | null
  apnsTeamId: string | null
  apnsTopic: string | null
  apnsEnvironment: 'sandbox' | 'production' | null
}

type TokenRow = {
  id: string
  userId: string
  token: string
  platform: 'ios' | 'android'
}

type SecretRow = { ref: string; ciphertext: string; iv: string; authTag: string }
type MemberRow = { userId: string; muted: boolean }
type UserRow = { id: string; preferences: unknown; displayName?: string }
type DeliveryRow = {
  organizationId: string
  userId: string
  messageId: string | null
  provider: 'apns' | 'fcm'
  status: 'sent' | 'failed' | 'dead'
  errorCode: string | null
  attempts: number
}

const encrypt = (plaintext: string): Omit<SecretRow, 'ref'> =>
  encryptWithKey(deriveSecretKey(AUTH_SECRET), plaintext)

type FakeState = {
  creds: CredRow[]
  members: MemberRow[]
  users?: UserRow[]
  tokens: TokenRow[]
  secrets: SecretRow[]
  channel: { label: string } | null
  deleted: string[]
  deliveries?: DeliveryRow[]
}

const member = (userId: string, muted = false): MemberRow => ({ userId, muted })

const makeFakePrisma = (state: FakeState): PushDispatchPrisma =>
  ({
    pushCredential: {
      findMany: async () => state.creds,
    },
    channelMember: {
      findMany: async () => state.members,
    },
    deviceToken: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
        state.tokens.filter((token) => where.userId.in.includes(token.userId)),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        state.deleted.push(...where.id.in)
        state.tokens = state.tokens.filter((t) => !where.id.in.includes(t.id))
        return { count: where.id.in.length }
      },
    },
    channel: {
      findUnique: async () => state.channel,
    },
    mcpOAuthSecret: {
      findUnique: async ({ where }: { where: { ref: string } }) =>
        state.secrets.find((s) => s.ref === where.ref) ?? null,
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const users = state.users ?? state.members.map((m) => ({ id: m.userId, preferences: null }))
        return users.filter((user) => where.id.in.includes(user.id))
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = (state.users ?? []).find((entry) => entry.id === where.id)
        return user ? { displayName: user.displayName ?? user.id } : null
      },
    },
    pushDelivery: {
      create: async ({ data }: { data: DeliveryRow }) => {
        state.deliveries?.push(data)
        return { id: crypto.randomUUID(), createdAt: new Date(), ...data }
      },
    },
  }) as unknown as PushDispatchPrisma

const recordingSenders = (): {
  senders: PushSenders
  apnsCalls: PushTarget[]
  fcmCalls: PushTarget[]
  apnsPayloads: PushPayload[]
  fcmPayloads: PushPayload[]
  results: Map<string, PushResult>
} => {
  const apnsCalls: PushTarget[] = []
  const fcmCalls: PushTarget[] = []
  const apnsPayloads: PushPayload[] = []
  const fcmPayloads: PushPayload[] = []
  const results = new Map<string, PushResult>()
  const okResult: PushResult = { ok: true, status: 200, deadToken: false }
  const senders: PushSenders = {
    sendApns: async (_c: ApnsCredentials, target, p: PushPayload) => {
      apnsCalls.push(target)
      apnsPayloads.push(p)
      return results.get(target.token) ?? okResult
    },
    sendFcm: async (_c: FcmCredentials, target, p: PushPayload) => {
      fcmCalls.push(target)
      fcmPayloads.push(p)
      return results.get(target.token) ?? okResult
    },
  }
  return { senders, apnsCalls, fcmCalls, apnsPayloads, fcmPayloads, results }
}

const apnsCred = (): CredRow => ({
  provider: 'apns',
  secretRef: 'secret_push_apns',
  apnsKeyId: 'KEY123',
  apnsTeamId: 'TEAM123',
  apnsTopic: 'com.example.app',
  apnsEnvironment: 'production',
})

const fcmCred = (): CredRow => ({
  provider: 'fcm',
  secretRef: 'secret_push_fcm',
  apnsKeyId: null,
  apnsTeamId: null,
  apnsTopic: null,
  apnsEnvironment: null,
})

const apnsSecret = (): SecretRow => ({ ref: 'secret_push_apns', ...encrypt('-----P8-----') })
const fcmSecret = (): SecretRow => ({
  ref: 'secret_push_fcm',
  ...encrypt('{"type":"service_account"}'),
})

const payload = (over: Record<string, unknown> = {}) => ({
  messageId: crypto.randomUUID(),
  authorUserId: 'author-1',
  channelId: 'channel-1',
  threadId: 'thread-1',
  organizationId: 'org-1',
  contentSnippet: 'hello world',
  mentionUserIds: [],
  ...over,
})

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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload(),
  )
  assert.deepEqual(summary, { sent: 0, failed: 0, pruned: 0 })
  assert.equal(apnsCalls.length, 0)
  assert.equal(fcmCalls.length, 0)
})

test('excludes the author and notifies only members (via channelMember filter)', async () => {
  // The handler passes `userId: { not: authorUserId }` to channelMember.findMany;
  // assert that filter is applied and only the returned members are targeted.
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
    { prisma, authSecret: AUTH_SECRET, senders },
    payload({ authorUserId: 'author-1' }),
  )
  assert.deepEqual(appliedWhere, {
    channelId: 'channel-1',
    userId: { not: 'author-1' },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload(),
  )
  assert.deepEqual(apnsCalls.map((c) => c.token), ['ios-tok'])
  assert.equal(fcmCalls.length, 0)
  assert.equal(summary.sent, 1)
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload(),
  )
  assert.deepEqual(apnsCalls.map((c) => c.token), ['ios-tok'])
  assert.deepEqual(fcmCalls.map((c) => c.token), ['and-tok'])
  assert.equal(summary.sent, 2)
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload(),
  )
  assert.equal(summary.failed, 1)
  assert.equal(summary.sent, 0)
  assert.deepEqual(state.deleted, [])
})

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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
      authSecret: AUTH_SECRET,
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
      authSecret: AUTH_SECRET,
      senders,
      now: () => new Date('2026-06-07T15:30:00.000Z'),
    },
    payload(),
  )

  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((c) => c.token), ['tok-u2'])
})

test('mentioned recipients get mention framing; unmentioned keep channel framing', async () => {
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
  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload({ mentionUserIds: ['u2'] }),
  )

  assert.equal(summary.sent, 2)
  const mentionedIdx = apnsCalls.findIndex((call) => call.token === 'tok-u2')
  const unmentionedIdx = apnsCalls.findIndex((call) => call.token === 'tok-u3')
  assert.ok(mentionedIdx >= 0 && unmentionedIdx >= 0)
  assert.equal(apnsPayloads[mentionedIdx]?.title, 'Ada Author mentioned you in General')
  assert.equal(apnsPayloads[unmentionedIdx]?.title, 'General')
  // Both groups carry the same deep-link data and coalescing key.
  assert.equal(apnsPayloads[mentionedIdx]?.collapseId, 'channel-1')
  assert.deepEqual(apnsPayloads[mentionedIdx]?.data, apnsPayloads[unmentionedIdx]?.data)
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload({ mentionUserIds: ['u2'] }),
  )

  // The muted mentioned member is suppressed; the alert row + bell badge are
  // still created API-side (covered by the api alert tests).
  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((call) => call.token), ['tok-u3'])
  assert.equal(apnsPayloads[0]?.title, 'General')
})
