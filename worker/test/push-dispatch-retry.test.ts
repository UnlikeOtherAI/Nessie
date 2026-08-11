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
import type { ApnsCredentials, FcmCredentials } from '@nessie/push'

const AUTH_SECRET = 'test-auth-secret'
const OK: PushResult = { ok: true, status: 200, deadToken: false, messageId: 'provider-id' }

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
type DeliveryRow = {
  organizationId: string
  userId: string
  messageId: string | null
  provider: 'apns' | 'fcm'
  status: 'sent' | 'failed' | 'dead'
  errorCode: string | null
  attempts: number
}

type FakeState = {
  creds: CredRow[]
  tokens: TokenRow[]
  deleted: string[]
  deliveries: DeliveryRow[]
  secrets: SecretRow[]
}

const encrypt = (plaintext: string): Omit<SecretRow, 'ref'> =>
  encryptWithKey(deriveSecretKey(AUTH_SECRET), plaintext)

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

const baseState = (tokens: TokenRow[], creds: CredRow[] = [apnsCred(), fcmCred()]): FakeState => ({
  creds,
  tokens,
  deleted: [],
  deliveries: [],
  secrets: [
    { ref: 'secret_push_apns', ...encrypt('-----P8-----') },
    { ref: 'secret_push_fcm', ...encrypt('{"type":"service_account"}') },
  ],
})

const makeFakePrisma = (state: FakeState): PushDispatchPrisma =>
  ({
    pushCredential: {
      findMany: async () => state.creds,
    },
    channelMember: {
      findMany: async () => state.tokens.map((token) => ({ userId: token.userId, muted: false })),
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
        return { count: where.id.in.length }
      },
    },
    channel: {
      findUnique: async () => ({ label: 'General' }),
    },
    mcpOAuthSecret: {
      findUnique: async ({ where }: { where: { ref: string } }) =>
        state.secrets.find((secret) => secret.ref === where.ref) ?? null,
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, preferences: null })),
    },
    pushDelivery: {
      create: async ({ data }: { data: DeliveryRow }) => {
        state.deliveries.push(data)
        return { id: crypto.randomUUID(), createdAt: new Date(), ...data }
      },
    },
    userPushSurfacePresence: {
      findMany: async () => [],
    },
  }) as unknown as PushDispatchPrisma

const sequenceSenders = (sequences: Record<string, PushResult[]>): {
  calls: Map<string, number>
  senders: PushSenders
} => {
  const calls = new Map<string, number>()
  const next = async (target: PushTarget): Promise<PushResult> => {
    calls.set(target.token, (calls.get(target.token) ?? 0) + 1)
    return sequences[target.token]?.shift() ?? OK
  }
  return {
    calls,
    senders: {
      sendApns: async (_c: ApnsCredentials, target: PushTarget, _p: PushPayload) =>
        next(target),
      sendFcm: async (_c: FcmCredentials, target: PushTarget, _p: PushPayload) =>
        next(target),
    },
  }
}

const payload = () => ({
  messageId: crypto.randomUUID(),
  authorUserId: crypto.randomUUID(),
  channelId: crypto.randomUUID(),
  threadId: crypto.randomUUID(),
  organizationId: crypto.randomUUID(),
  contentSnippet: 'hello world',
  mentionUserIds: [],
})

const dispatch = (
  state: FakeState,
  senders: PushSenders,
) =>
  handlePushDispatch(
    {
      prisma: makeFakePrisma(state),
      authSecret: AUTH_SECRET,
      retryDelayMs: () => 0,
      senders,
    },
    payload(),
  )

test('retries a transient FCM failure and records the successful final outcome', async () => {
  const state = baseState([
    { id: 'android-1', userId: crypto.randomUUID(), token: 'fcm-1', platform: 'android' },
  ])
  const { calls, senders } = sequenceSenders({
    'fcm-1': [
      { ok: false, status: 503, deadToken: false, error: 'UNAVAILABLE' },
      OK,
    ],
  })

  const summary = await dispatch(state, senders)

  assert.equal(calls.get('fcm-1'), 2)
  assert.deepEqual(summary, { sent: 1, failed: 0, pruned: 0 })
  assert.deepEqual(state.deliveries.map((delivery) => ({
    provider: delivery.provider,
    status: delivery.status,
    attempts: delivery.attempts,
    errorCode: delivery.errorCode,
  })), [{ provider: 'fcm', status: 'sent', attempts: 2, errorCode: null }])
})

test('records failed after exhausting transient retry attempts', async () => {
  const state = baseState([
    { id: 'android-1', userId: crypto.randomUUID(), token: 'fcm-1', platform: 'android' },
  ])
  const { calls, senders } = sequenceSenders({
    'fcm-1': [
      { ok: false, status: 0, deadToken: false, error: 'network down' },
      { ok: false, status: 0, deadToken: false, error: 'network down' },
      { ok: false, status: 0, deadToken: false, error: 'network down' },
    ],
  })

  const summary = await dispatch(state, senders)

  assert.equal(calls.get('fcm-1'), 3)
  assert.deepEqual(summary, { sent: 0, failed: 1, pruned: 0 })
  assert.equal(state.deliveries[0]?.status, 'failed')
  assert.equal(state.deliveries[0]?.attempts, 3)
  assert.equal(state.deliveries[0]?.errorCode, 'network down')
})

test('does not retry dead tokens and records the dead delivery before pruning', async () => {
  const state = baseState([
    { id: 'ios-dead', userId: crypto.randomUUID(), token: 'apns-dead', platform: 'ios' },
  ])
  const { calls, senders } = sequenceSenders({
    'apns-dead': [
      { ok: false, status: 410, deadToken: true, error: 'Unregistered' },
    ],
  })

  const summary = await dispatch(state, senders)

  assert.equal(calls.get('apns-dead'), 1)
  assert.deepEqual(summary, { sent: 0, failed: 1, pruned: 1 })
  assert.deepEqual(state.deleted, ['ios-dead'])
  assert.deepEqual(state.deliveries.map((delivery) => ({
    provider: delivery.provider,
    status: delivery.status,
    attempts: delivery.attempts,
    errorCode: delivery.errorCode,
  })), [{ provider: 'apns', status: 'dead', attempts: 1, errorCode: 'Unregistered' }])
})

test('records one delivery row for each final token outcome', async () => {
  const state = baseState([
    { id: 'ios-ok', userId: crypto.randomUUID(), token: 'apns-ok', platform: 'ios' },
    { id: 'fcm-fail', userId: crypto.randomUUID(), token: 'fcm-fail', platform: 'android' },
    { id: 'ios-dead', userId: crypto.randomUUID(), token: 'apns-dead', platform: 'ios' },
  ])
  const { senders } = sequenceSenders({
    'apns-ok': [OK],
    'fcm-fail': [
      { ok: false, status: 400, deadToken: false, error: 'INVALID_ARGUMENT' },
    ],
    'apns-dead': [
      { ok: false, status: 410, deadToken: true, error: 'Unregistered' },
    ],
  })

  const summary = await dispatch(state, senders)

  assert.deepEqual(summary, { sent: 1, failed: 2, pruned: 1 })
  assert.deepEqual(
    state.deliveries.map((delivery) => delivery.status).sort(),
    ['dead', 'failed', 'sent'],
  )
  assert.equal(state.deliveries.length, 3)
  assert.equal(new Set(state.deliveries.map((delivery) => delivery.organizationId)).size, 1)
})
