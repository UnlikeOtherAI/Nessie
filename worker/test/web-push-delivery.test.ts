import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import type {
  PushPayload,
  PushResult,
  WebPushCredentials,
  WebPushTarget,
} from '@nessie/push'
import { UrlSafetyError } from '@nessie/runtime'
import {
  deliverWebPush,
  type WebPushDeliveryPrisma,
  type WebPushSender,
} from '../src/control/web-push-delivery.js'

const CREDS: WebPushCredentials = {
  publicKey: 'pub',
  privateKey: 'priv',
  subject: 'mailto:ops@example.com',
}

type SubRow = {
  id: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
}

type DeliveryRow = {
  organizationId: string
  userId: string
  messageId: string | null
  provider: string
  status: 'sent' | 'failed' | 'dead'
  errorCode: string | null
  attempts: number
}

type FakeState = {
  subs: SubRow[]
  deleted: string[]
  deliveries: DeliveryRow[]
}

const makeFakePrisma = (state: FakeState): WebPushDeliveryPrisma =>
  ({
    webPushSubscription: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
        state.subs.filter((s) => where.userId.in.includes(s.userId)),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        state.deleted.push(...where.id.in)
        return { count: where.id.in.length }
      },
    },
    pushDelivery: {
      create: async ({ data }: { data: DeliveryRow }) => {
        state.deliveries.push(data)
        return { id: crypto.randomUUID(), createdAt: new Date(), ...data }
      },
    },
  }) as unknown as WebPushDeliveryPrisma

const recordingSender = (): {
  sender: WebPushSender
  calls: { target: WebPushTarget; payload: PushPayload }[]
  results: Map<string, PushResult>
} => {
  const calls: { target: WebPushTarget; payload: PushPayload }[] = []
  const results = new Map<string, PushResult>()
  const ok: PushResult = { ok: true, status: 201, deadToken: false }
  const sender: WebPushSender = async (_c, target, payload) => {
    calls.push({ target, payload })
    return results.get(target.endpoint) ?? ok
  }
  return { sender, calls, results }
}

const sub = (id: string, userId: string): SubRow => ({
  id,
  userId,
  endpoint: `https://push.example.com/${id}`,
  p256dh: `p256dh-${id}`,
  auth: `auth-${id}`,
})

const basePayload: PushPayload = {
  title: 'General',
  body: 'hello world',
  data: { channelId: 'channel-1', threadId: 'thread-1', messageId: 'msg-1' },
  collapseId: 'channel-1',
}

// Passthrough SSRF guard so tests stay hermetic (no real DNS resolution).
const allowAll = async (_url: string) => undefined

const input = (state: FakeState, sender: WebPushSender) => ({
  prisma: makeFakePrisma(state),
  creds: CREDS,
  recipientIds: ['u2'],
  payload: basePayload,
  organizationId: 'org-1',
  messageId: 'msg-1',
  channelId: 'channel-1',
  sender,
  urlGuard: allowAll,
})

test('delivers to a recipient subscription with a deep-link url', async () => {
  const state: FakeState = { subs: [sub('s1', 'u2')], deleted: [], deliveries: [] }
  const { sender, calls } = recordingSender()
  const summary = await deliverWebPush(input(state, sender))

  assert.deepEqual(summary, { sent: 1, failed: 0, pruned: 0 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.target, {
    endpoint: 'https://push.example.com/s1',
    p256dh: 'p256dh-s1',
    auth: 'auth-s1',
  })
  assert.equal(calls[0]!.payload.data?.url, '/channels/channel-1')
  assert.equal(calls[0]!.payload.data?.channelId, 'channel-1')
  assert.equal(calls[0]!.payload.title, 'General')
  assert.deepEqual(state.deliveries, [{
    organizationId: 'org-1',
    userId: 'u2',
    messageId: 'msg-1',
    provider: 'webpush',
    status: 'sent',
    errorCode: null,
    attempts: 1,
  }])
})

test('prunes a subscription the push service reports gone (410)', async () => {
  const state: FakeState = { subs: [sub('s1', 'u2')], deleted: [], deliveries: [] }
  const { sender, results } = recordingSender()
  results.set('https://push.example.com/s1', {
    ok: false,
    status: 410,
    deadToken: true,
    error: 'Gone',
  })
  const summary = await deliverWebPush(input(state, sender))

  assert.deepEqual(summary, { sent: 0, failed: 1, pruned: 1 })
  assert.deepEqual(state.deleted, ['s1'])
  assert.equal(state.deliveries[0]!.status, 'dead')
  assert.equal(state.deliveries[0]!.errorCode, 'Gone')
})

test('a thrown sender is recorded as a non-dead failure, not pruned', async () => {
  const state: FakeState = { subs: [sub('s1', 'u2')], deleted: [], deliveries: [] }
  const sender: WebPushSender = async () => {
    throw new Error('network down')
  }
  const summary = await deliverWebPush(input(state, sender))

  assert.deepEqual(summary, { sent: 0, failed: 1, pruned: 0 })
  assert.deepEqual(state.deleted, [])
  assert.equal(state.deliveries[0]!.status, 'failed')
  assert.equal(state.deliveries[0]!.errorCode, 'network down')
})

test('skips an endpoint the SSRF guard rejects without sending or pruning', async () => {
  const state: FakeState = { subs: [sub('s1', 'u2')], deleted: [], deliveries: [] }
  const { sender, calls } = recordingSender()
  const denyAll = async () => { throw new UrlSafetyError('blocked') }
  const summary = await deliverWebPush({ ...input(state, sender), urlGuard: denyAll })

  assert.equal(calls.length, 0, 'must not POST to an unsafe endpoint')
  // Not pruned: a guard failure (which also covers transient DNS errors) must
  // not destroy a subscription — it just fails harmlessly this round.
  assert.deepEqual(summary, { sent: 0, failed: 1, pruned: 0 })
  assert.deepEqual(state.deleted, [])
  assert.equal(state.deliveries[0]!.status, 'failed')
})

test('no-ops when there are no recipients or no subscriptions', async () => {
  const { sender, calls } = recordingSender()
  const empty: FakeState = { subs: [], deleted: [], deliveries: [] }
  const a = await deliverWebPush({ ...input(empty, sender), recipientIds: [] })
  const b = await deliverWebPush(input(empty, sender))

  assert.deepEqual(a, { sent: 0, failed: 0, pruned: 0 })
  assert.deepEqual(b, { sent: 0, failed: 0, pruned: 0 })
  assert.equal(calls.length, 0)
})
