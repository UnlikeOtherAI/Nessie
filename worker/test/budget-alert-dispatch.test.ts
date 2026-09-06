import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import type {
  ApnsCredentials,
  PushPayload,
  PushResult,
  PushTarget,
} from '@nessie/push'
import type { BudgetAlertDispatchJobPayload } from '@nessie/schemas'
import {
  handleBudgetAlertDispatch,
  type BudgetAlertDispatchPrisma,
} from '../src/control/budget-alert-dispatch.js'
import type { PushSenders } from '../src/control/push-delivery-core.js'

const AUTH_SECRET = 'test-auth-secret'

const encrypt = (plaintext: string) => encryptWithKey(deriveSecretKey(AUTH_SECRET), plaintext)

type OrgMember = { userId: string; role: 'owner' | 'admin' | 'member'; deactivatedAt: Date | null }
type ScopeMember = { userId: string; role: 'owner' | 'admin' | 'member' }

type FakeState = {
  orgMembers: OrgMember[]
  teamMembers: ScopeMember[]
  projectMembers: ScopeMember[]
  users: Array<{ id: string; preferences: unknown }>
  tokens: Array<{ id: string; userId: string; token: string; platform: 'ios' | 'android' }>
}

const makeFakePrisma = (state: FakeState): BudgetAlertDispatchPrisma =>
  ({
    // The exactly-once claim (`push_send_claims`). A fresh fake always wins it;
    // the losing side is proved against the real unique index in
    // `test/db/push-dispatch-idempotency.test.ts`.
    $executeRaw: async () => 1,
    pushCredential: {
      findMany: async () => [
        {
          provider: 'apns',
          secretRef: 'secret_push_apns',
          apnsKeyId: 'KEY123',
          apnsTeamId: 'TEAM123',
          apnsTopic: 'com.example.app',
          apnsEnvironment: 'production',
        },
      ],
    },
    mcpOAuthSecret: {
      findUnique: async ({ where }: { where: { ref: string } }) =>
        where.ref === 'secret_push_apns'
          ? { ref: 'secret_push_apns', ...encrypt('-----P8-----') }
          : null,
    },
    organizationMember: {
      findMany: async ({
        where,
      }: {
        where: { deactivatedAt: null; role: 'owner' }
      }) =>
        state.orgMembers
          .filter((m) => m.deactivatedAt === null && m.role === where.role)
          .map((m) => ({ userId: m.userId })),
    },
    teamMember: {
      findMany: async ({ where }: { where: { role: { in: string[] } } }) =>
        state.teamMembers
          .filter((m) => where.role.in.includes(m.role))
          .map((m) => ({ userId: m.userId })),
    },
    projectMember: {
      findMany: async ({ where }: { where: { role: { in: string[] } } }) =>
        state.projectMembers
          .filter((m) => where.role.in.includes(m.role))
          .map((m) => ({ userId: m.userId })),
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        state.users.filter((u) => where.id.in.includes(u.id)),
    },
    deviceToken: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; userId: { in: string[] } }
      }) =>
        state.tokens.filter((t) => where.userId.in.includes(t.userId)),
      deleteMany: async () => ({ count: 0 }),
    },
    pushDelivery: {
      create: async ({ data }: { data: unknown }) => ({ id: crypto.randomUUID(), ...(data as object) }),
    },
    userPushSurfacePresence: {
      findMany: async () => [],
    },
    webPushSubscription: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
  }) as unknown as BudgetAlertDispatchPrisma

const recordingSenders = (): {
  senders: PushSenders
  apnsCalls: PushTarget[]
  apnsPayloads: PushPayload[]
} => {
  const apnsCalls: PushTarget[] = []
  const apnsPayloads: PushPayload[] = []
  const ok: PushResult = { ok: true, status: 200, deadToken: false }
  const senders: PushSenders = {
    sendApns: async (_c: ApnsCredentials, target: PushTarget, payload: PushPayload) => {
      apnsCalls.push(target)
      apnsPayloads.push(payload)
      return ok
    },
    sendFcm: async () => ok,
  }
  return { senders, apnsCalls, apnsPayloads }
}

const teamPayload = (): BudgetAlertDispatchJobPayload => ({
  organizationId: 'org-1',
  scopeType: 'team',
  scopeId: 'team-1',
  kind: 'threshold',
  period: 'monthly',
  scopeLabel: 'Team Squad',
  percentUsed: 85,
  reason: 'Team Squad has used 85% — $85.00 of $100.00 this month.',
})

const tok = (userId: string): FakeState['tokens'][number] => ({
  id: `tok-${userId}`,
  userId,
  token: `device-${userId}`,
  platform: 'ios',
})

test('notifies only active organisation owners for a team budget', async () => {
  const state: FakeState = {
    orgMembers: [
      { userId: 'owner-1', role: 'owner', deactivatedAt: null },
      { userId: 'admin-1', role: 'admin', deactivatedAt: null },
      { userId: 'owner-gone', role: 'owner', deactivatedAt: new Date() },
      { userId: 'plain', role: 'member', deactivatedAt: null },
    ],
    teamMembers: [
      { userId: 'owner-1', role: 'admin' }, // also an org owner — must dedupe
      { userId: 'team-mgr', role: 'admin' },
      { userId: 'team-plain', role: 'member' },
    ],
    projectMembers: [],
    users: [
      { id: 'owner-1', preferences: null },
      { id: 'admin-1', preferences: null },
      { id: 'team-mgr', preferences: null },
    ],
    tokens: [tok('owner-1'), tok('admin-1'), tok('team-mgr')],
  }
  const { senders, apnsCalls } = recordingSenders()

  const summary = await handleBudgetAlertDispatch(
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders, retryDelayMs: () => 0 },
    teamPayload(),
  )

  const notified = apnsCalls.map((c) => c.token).sort()
  assert.deepEqual(notified, ['device-owner-1'])
  assert.equal(summary.sent, 1)
})

test('respects push preferences (pushEnabled=false is suppressed)', async () => {
  const state: FakeState = {
    orgMembers: [{ userId: 'owner-1', role: 'owner', deactivatedAt: null }],
    teamMembers: [{ userId: 'team-mgr', role: 'admin' }],
    projectMembers: [],
    users: [
      { id: 'owner-1', preferences: { pushEnabled: false } },
      { id: 'team-mgr', preferences: null },
    ],
    tokens: [tok('owner-1'), tok('team-mgr')],
  }
  const { senders, apnsCalls } = recordingSenders()

  await handleBudgetAlertDispatch(
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders, retryDelayMs: () => 0 },
    teamPayload(),
  )

  assert.deepEqual(apnsCalls.map((c) => c.token), [])
})

test('org-scoped budget notifies owners', async () => {
  const state: FakeState = {
    orgMembers: [
      { userId: 'owner-1', role: 'owner', deactivatedAt: null },
      { userId: 'admin-1', role: 'admin', deactivatedAt: null },
      { userId: 'plain', role: 'member', deactivatedAt: null },
    ],
    teamMembers: [],
    projectMembers: [],
    users: [
      { id: 'owner-1', preferences: null },
      { id: 'admin-1', preferences: null },
    ],
    tokens: [tok('owner-1'), tok('admin-1')],
  }
  const { senders, apnsCalls } = recordingSenders()

  await handleBudgetAlertDispatch(
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders, retryDelayMs: () => 0 },
    { ...teamPayload(), scopeType: 'organization', scopeId: 'org-1', scopeLabel: 'Acme' },
  )

  assert.deepEqual(apnsCalls.map((c) => c.token), ['device-owner-1'])
})

test('budget alerts include the Ops usage deep link in native payloads', async () => {
  const state: FakeState = {
    orgMembers: [{ userId: 'owner-1', role: 'owner', deactivatedAt: null }],
    teamMembers: [],
    projectMembers: [],
    users: [{ id: 'owner-1', preferences: null }],
    tokens: [tok('owner-1')],
  }
  const { senders, apnsPayloads } = recordingSenders()

  await handleBudgetAlertDispatch(
    { prisma: makeFakePrisma(state), authSecret: AUTH_SECRET, senders, retryDelayMs: () => 0 },
    { ...teamPayload(), scopeType: 'organization', scopeId: 'org-1', scopeLabel: 'Acme' },
  )

  assert.equal(apnsPayloads[0]?.data?.url, '/ops/usage')
})
