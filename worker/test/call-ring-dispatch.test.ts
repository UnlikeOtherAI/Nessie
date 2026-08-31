import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import type { ApnsCredentials, PushPayload, PushResult, PushTarget } from '@nessie/push'

import {
  handleCallRingDispatch,
  type CallRingDispatchPrisma,
} from '../src/control/call-ring-dispatch.js'

const AUTH_SECRET = 'call-ring-test-secret'
const ids = {
  call: '00000000-0000-4000-8000-000000000001',
  channel: '00000000-0000-4000-8000-000000000002',
  organization: '00000000-0000-4000-8000-000000000003',
  user: '00000000-0000-4000-8000-000000000004',
}

test('a ring bypasses foreground surface suppression and native payloads never carry the meeting URL', async () => {
  const encrypted = encryptWithKey(deriveSecretKey(AUTH_SECRET), '-----P8-----')
  const nativePayloads: PushPayload[] = []
  const prisma = {
    call: {
      findUnique: async () => ({
        channel: { id: ids.channel, label: 'General', organizationId: ids.organization },
        id: ids.call,
        invites: [{ state: 'ringing' }],
        meetingUri: 'https://meet.example.test/abc-defg-hij',
        revision: 7,
        ringExpiresAt: new Date('2026-09-01T10:00:00.000Z'),
        startedBy: { displayName: 'Caller' },
        status: 'ringing',
      }),
    },
    channelMember: { findFirst: async () => ({ id: 'channel-member' }) },
    deviceToken: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => [{ id: 'device', platform: 'ios', token: 'native-token', userId: ids.user }],
    },
    mcpOAuthSecret: {
      findUnique: async () => ({ ref: 'push-secret', ...encrypted }),
    },
    organizationMember: { findFirst: async () => ({ id: 'organization-member' }) },
    pushCredential: {
      findMany: async () => [{
        apnsEnvironment: 'production',
        apnsKeyId: 'KEY',
        apnsTeamId: 'TEAM',
        apnsTopic: 'works.nessie.app',
        provider: 'apns',
        secretRef: 'push-secret',
      }],
    },
    pushDelivery: { create: async () => ({ id: 'delivery' }) },
    user: { findUnique: async () => ({ preferences: {} }) },
    // A ring must skip every surface-presence check. Throwing makes this test
    // cover the pre-fanout, per-native-token, and web-delivery bypass path.
    userPushSurfacePresence: { findMany: async () => { throw new Error('ring checked foreground surface') } },
    webPushSubscription: { findMany: async () => [] },
  } as unknown as CallRingDispatchPrisma

  const summary = await handleCallRingDispatch({
    authSecret: AUTH_SECRET,
    now: () => new Date('2026-09-01T09:00:00.000Z'),
    prisma,
    retryDelayMs: () => 0,
    senders: {
      sendApns: async (_credentials: ApnsCredentials, _target: PushTarget, payload: PushPayload): Promise<PushResult> => {
        nativePayloads.push(payload)
        return { deadToken: false, ok: true, status: 200 }
      },
      sendFcm: async () => ({ deadToken: false, ok: true, status: 200 }),
    },
  }, { callId: ids.call, userId: ids.user })

  assert.deepEqual(summary, { failed: 0, pruned: 0, sent: 1 })
  assert.equal(nativePayloads.length, 1)
  const payload = nativePayloads[0]!
  assert.equal(payload.data?.callId, ids.call)
  assert.equal(payload.data?.path, `/channels/${ids.channel}?incomingCall=${ids.call}`)
  assert.equal(payload.data?.revision, '7')
  assert.equal(payload.data?.version, '1')
  assert.ok(!Object.values(payload.data ?? {}).some((value) => value.includes('https://')))
  assert.equal(payload.data?.meetingUri, undefined)
})

test('a queued ring does not reach an invitee who has already responded', async () => {
  const prisma = {
    call: {
      findUnique: async () => ({
        channel: { id: ids.channel, label: 'General', organizationId: ids.organization },
        id: ids.call,
        invites: [{ state: 'declined' }],
        meetingUri: 'https://meet.example.test/abc-defg-hij',
        revision: 7,
        ringExpiresAt: new Date('2026-09-01T10:00:00.000Z'),
        startedBy: { displayName: 'Caller' },
        status: 'ringing',
      }),
    },
    channelMember: { findFirst: async () => ({ id: 'channel-member' }) },
    organizationMember: { findFirst: async () => ({ id: 'organization-member' }) },
    user: { findUnique: async () => ({ preferences: {} }) },
  } as unknown as CallRingDispatchPrisma

  const summary = await handleCallRingDispatch({
    authSecret: AUTH_SECRET,
    now: () => new Date('2026-09-01T09:00:00.000Z'),
    prisma,
  }, { callId: ids.call, userId: ids.user })

  assert.deepEqual(summary, { failed: 0, pruned: 0, sent: 0 })
})
