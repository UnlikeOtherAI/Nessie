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
  apnsEnvironment?: 'sandbox' | 'production'
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
type SurfaceViewer = {
  channelId: string | null
  kind: 'channel' | 'ops_usage'
  rootMessageId: string | null
  threadId: string | null
  userId: string
}

const encrypt = (plaintext: string): Omit<SecretRow, 'ref'> =>
  encryptWithKey(deriveSecretKey(AUTH_SECRET), plaintext)

type FakeMessage = {
  agent: { name: string } | null
  agentId: string | null
  basisScopes: { scopeId: string; scopeType: string }[]
  user: { displayName: string } | null
}

type FakeState = {
  creds: CredRow[]
  members: MemberRow[]
  users?: UserRow[]
  tokens: TokenRow[]
  secrets: SecretRow[]
  channel: { label: string } | null
  message?: FakeMessage | null
  disclosureGrants?: { grantedByUserId: string }[]
  activeOrganizationMemberIds?: string[]
  deleted: string[]
  deliveries?: DeliveryRow[]
  surfaceViewers?: SurfaceViewer[]
}

const member = (userId: string, muted = false): MemberRow => ({ userId, muted })

const makeFakePrisma = (state: FakeState): PushDispatchPrisma =>
  ({
    pushCredential: {
      findMany: async () => state.creds,
    },
    channelMember: {
      findMany: async ({ where }: {
        where: { userId: string | { in?: string[]; not?: string } }
      }) => {
        if (typeof where.userId === 'string') {
          return state.members
            .filter((member) => member.userId === where.userId)
            .map((member) => ({ channelId: 'channel-1', ...member }))
        }
        return state.members.filter((member) =>
          where.userId.in
            ? where.userId.in.includes(member.userId)
            : member.userId !== where.userId.not,
        )
      },
    },
    deviceToken: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; userId: { in: string[] } }
      }) =>
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
    message: {
      findUnique: async () => state.message ?? {
        agent: null,
        agentId: null,
        basisScopes: [],
        user: (() => {
          const author = (state.users ?? []).find((entry) => entry.id === 'author-1')
          return author ? { displayName: author.displayName ?? author.id } : null
        })(),
      },
    },
    teamMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
    organizationMember: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        state.activeOrganizationMemberIds === undefined
        || state.activeOrganizationMemberIds.includes(where.userId)
          ? { id: 'active-membership' }
          : null,
    },
    disclosureGrant: { findMany: async () => state.disclosureGrants ?? [] },
    scopeDisclosureGrant: { findMany: async () => [] },
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
    userPushSurfacePresence: {
      findMany: async ({ where }: {
        where: {
          channelId: string | null
          rootMessageId: string | null
          surfaceKind: string
          threadId: string | null
          userId: { in: string[] }
        }
      }) =>
        (state.surfaceViewers ?? [])
          .filter((viewer) =>
            where.userId.in.includes(viewer.userId)
            && viewer.kind === where.surfaceKind
            && viewer.channelId === where.channelId
            && viewer.rootMessageId === where.rootMessageId
            && viewer.threadId === where.threadId,
          )
          .map((viewer) => ({ userId: viewer.userId })),
    },
  }) as unknown as PushDispatchPrisma

const recordingSenders = (): {
  senders: PushSenders
  apnsCalls: PushTarget[]
  fcmCalls: PushTarget[]
  apnsPayloads: PushPayload[]
  apnsCredentials: ApnsCredentials[]
  fcmPayloads: PushPayload[]
  results: Map<string, PushResult>
} => {
  const apnsCalls: PushTarget[] = []
  const fcmCalls: PushTarget[] = []
  const apnsPayloads: PushPayload[] = []
  const apnsCredentials: ApnsCredentials[] = []
  const fcmPayloads: PushPayload[] = []
  const results = new Map<string, PushResult>()
  const okResult: PushResult = { ok: true, status: 200, deadToken: false }
  const senders: PushSenders = {
    sendApns: async (credentials: ApnsCredentials, target, p: PushPayload) => {
      apnsCalls.push(target)
      apnsPayloads.push(p)
      apnsCredentials.push(credentials)
      return results.get(target.token) ?? okResult
    },
    sendFcm: async (_c: FcmCredentials, target, p: PushPayload) => {
      fcmCalls.push(target)
      fcmPayloads.push(p)
      return results.get(target.token) ?? okResult
    },
  }
  return { senders, apnsCalls, fcmCalls, apnsPayloads, apnsCredentials, fcmPayloads, results }
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
  messageId: 'message-1',
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    secrets: [apnsSecret(), fcmSecret()],
    surfaceViewers: [{ userId: 'u2', kind: 'channel', channelId: 'channel-1', rootMessageId: null, threadId: 'thread-2' }],
    tokens: [
      { id: 'iphone', userId: 'u2', token: 'tok-iphone', platform: 'ios' },
      { id: 'ipad', userId: 'u2', token: 'tok-ipad', platform: 'ios' },
      { id: 'android', userId: 'u2', token: 'tok-android', platform: 'android' },
    ],
  }
  const { apnsCalls, apnsPayloads, fcmCalls, senders } = recordingSenders()

  const summary = await handlePushDispatch(
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload(),
  )

  assert.deepEqual(summary, { sent: 3, failed: 0, pruned: 0 })
  assert.deepEqual(apnsCalls.map((target) => target.token), ['tok-iphone', 'tok-ipad'])
  assert.deepEqual(fcmCalls.map((target) => target.token), ['tok-android'])
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
  assert.equal(apnsPayloads[0]?.subtitle, 'to General')
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma, authSecret: AUTH_SECRET, senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma, authSecret: AUTH_SECRET, senders: recordingSenders().senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
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

test('message recipients see the sender and destination, including mentions', async () => {
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    dispatchPayload,
  )

  assert.equal(summary.sent, 2)
  const mentionedIdx = apnsCalls.findIndex((call) => call.token === 'tok-u2')
  const unmentionedIdx = apnsCalls.findIndex((call) => call.token === 'tok-u3')
  assert.ok(mentionedIdx >= 0 && unmentionedIdx >= 0)
  assert.equal(apnsPayloads[mentionedIdx]?.title, 'Ada Author')
  assert.equal(apnsPayloads[mentionedIdx]?.subtitle, 'to General')
  assert.equal(apnsPayloads[unmentionedIdx]?.title, 'Ada Author')
  assert.equal(apnsPayloads[unmentionedIdx]?.subtitle, 'to General')
  // Both groups carry the same title, deep-link data, and coalescing key.
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
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders },
    payload({ mentionUserIds: ['u2'] }),
  )

  // The muted mentioned member is suppressed; the alert row + bell badge are
  // still created API-side (covered by the api alert tests).
  assert.equal(summary.sent, 1)
  assert.deepEqual(apnsCalls.map((call) => call.token), ['tok-u3'])
  assert.equal(apnsPayloads[0]?.title, 'Ada Author')
  assert.equal(apnsPayloads[0]?.subtitle, 'to General')
})
