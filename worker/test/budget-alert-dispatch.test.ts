import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { AT_REST_SECRET_PURPOSE, encryptWithKeyRing } from '@nessie/runtime'
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
const ENCRYPTION_KEY_RING = {
  activeVersion: 'test-key',
  keys: { 'test-key': 'test-at-rest-encryption-root' },
  legacyKey: AUTH_SECRET,
} as const

const encrypt = (plaintext: string) => encryptWithKeyRing(ENCRYPTION_KEY_RING, AT_REST_SECRET_PURPOSE.pushCredential, plaintext)

type OrgMember = { userId: string; role: 'owner' | 'admin' | 'member'; deactivatedAt: Date | null }
type ScopeMember = { userId: string; role: 'owner' | 'admin' | 'member' }

type Marker = {
  id: string
  organizationId: string
  scopeType: string
  scopeId: string
  periodStart: Date
  kind: string
}

type WrittenAlert = {
  budgetAlertId: string
  eventKey: string
  kind: string
  organizationId: string
  userId: string
}

type FakeState = {
  // The `budget_alerts` markers the enqueue claimed, and the bell rows written.
  markers?: Marker[]
  alerts?: WrittenAlert[]
  // No APNs/FCM credentials and no Web Push: nothing can be pushed.
  noPushCredentials?: boolean
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
    budgetAlert: {
      findUnique: async ({
        where,
      }: {
        where: { scopeType_scopeId_periodStart_kind: Omit<Marker, 'id' | 'organizationId'> }
      }) => {
        const key = where.scopeType_scopeId_periodStart_kind
        return (state.markers ?? []).find((marker) =>
          marker.scopeType === key.scopeType
          && marker.scopeId === key.scopeId
          && marker.kind === key.kind
          && marker.periodStart.getTime() === key.periodStart.getTime()) ?? null
      },
    },
    userAlert: {
      // Mirrors `skipDuplicates` over the (user_id, event_key) unique index.
      createMany: async ({ data }: { data: WrittenAlert[] }) => {
        state.alerts ??= []
        let count = 0
        for (const row of data) {
          if (state.alerts.some((a) => a.userId === row.userId && a.eventKey === row.eventKey)) continue
          state.alerts.push(row)
          count += 1
        }
        return { count }
      },
    },
    pushCredential: {
      findMany: async () => state.noPushCredentials ? [] : [
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
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders, retryDelayMs: () => 0 },
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
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders, retryDelayMs: () => 0 },
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
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders, retryDelayMs: () => 0 },
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
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders, retryDelayMs: () => 0 },
    { ...teamPayload(), scopeType: 'organization', scopeId: 'org-1', scopeLabel: 'Acme' },
  )

  assert.equal(apnsPayloads[0]?.data?.url, '/admin/usage')
})

// Plan §10.9: budget alerts reach the bell. The row is written for every active
// owner before any push, so it does not depend on a registered device or on the
// owner's push preferences — those silence the push, never the row.
const PERIOD_START = '2026-09-01T00:00:00.000Z'
const marker = (over: Partial<Marker> = {}): Marker => ({
  id: 'marker-1',
  organizationId: 'org-1',
  scopeType: 'team',
  scopeId: 'team-1',
  periodStart: new Date(PERIOD_START),
  kind: 'threshold',
  ...over,
})
const ownersState = (over: Partial<FakeState> = {}): FakeState => ({
  markers: [marker()],
  orgMembers: [
    { userId: 'owner-1', role: 'owner', deactivatedAt: null },
    { userId: 'owner-2', role: 'owner', deactivatedAt: null },
    { userId: 'owner-gone', role: 'owner', deactivatedAt: new Date() },
    { userId: 'admin-1', role: 'admin', deactivatedAt: null },
  ],
  teamMembers: [],
  projectMembers: [],
  users: [
    { id: 'owner-1', preferences: { pushEnabled: false } },
    { id: 'owner-2', preferences: null },
  ],
  tokens: [tok('owner-2')],
  ...over,
})

test('every active owner gets a bell row, even with pushes off and no devices', async () => {
  const state = ownersState({ noPushCredentials: true })
  const summary = await handleBudgetAlertDispatch(
    { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, retryDelayMs: () => 0 },
    { ...teamPayload(), periodStart: PERIOD_START },
  )

  assert.equal(summary.sent, 0)
  assert.deepEqual(
    (state.alerts ?? []).map((row) => [row.userId, row.kind, row.budgetAlertId]).sort(),
    [['owner-1', 'budget_alert', 'marker-1'], ['owner-2', 'budget_alert', 'marker-1']],
  )
  assert.deepEqual(
    [...new Set((state.alerts ?? []).map((row) => row.eventKey))],
    [`budget-alert:team:team-1:${PERIOD_START}:threshold`],
  )
})

test('a redelivered job writes no second row, and the push goes only where allowed', async () => {
  const state = ownersState()
  const { senders, apnsCalls } = recordingSenders()
  const deps = { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, senders, retryDelayMs: () => 0 }
  await handleBudgetAlertDispatch(deps, { ...teamPayload(), periodStart: PERIOD_START })
  await handleBudgetAlertDispatch(deps, { ...teamPayload(), periodStart: PERIOD_START })

  assert.equal(state.alerts?.length, 2)
  // owner-1 turned pushes off: a bell row, no push. owner-2 is pushed.
  assert.ok(apnsCalls.length > 0)
  assert.ok(apnsCalls.every((call) => call.token === 'device-owner-2'))
})

test('no bell row without the marker the enqueue claimed', async () => {
  // A job from a replica of the previous build names no window, so it cannot
  // name its marker; a marker in another organisation is never this job's.
  const cases: Array<{ payload: BudgetAlertDispatchJobPayload; markers: Marker[] }> = [
    { payload: teamPayload(), markers: [marker()] },
    { payload: { ...teamPayload(), periodStart: PERIOD_START }, markers: [marker({ organizationId: 'org-2' })] },
    { payload: { ...teamPayload(), periodStart: PERIOD_START, kind: 'blocked' }, markers: [marker()] },
  ]
  for (const { payload, markers } of cases) {
    const state = ownersState({ markers, noPushCredentials: true })
    await handleBudgetAlertDispatch(
      { prisma: makeFakePrisma(state), encryptionKeyRing: ENCRYPTION_KEY_RING, retryDelayMs: () => 0 },
      payload,
    )
    assert.deepEqual(state.alerts ?? [], [])
  }
})
