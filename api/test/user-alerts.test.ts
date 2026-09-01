import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { registerAlertRoutes } from '../src/routes/alerts.js'
import { listUserAlerts, markUserAlertsRead } from '../src/services/alerts.js'
import { createThreadMessage } from '../src/services/message-create.js'
import { actorContext, buildDeps } from './conformance/harness.js'
import { TenantStore } from './conformance/tenant-store.js'

// ─── createThreadMessage: mention alert rows ────────────────────────────────

type AlertCreate = {
  organizationId: string
  userId: string
  kind: string
  messageId: string
  threadId: string
  channelId: string
  actorUserId: string | null
  actorAgentId: string | null
}

const makeMessagePrisma = (input: {
  members: { id: string; displayName: string }[]
}) => {
  const calls = { alertCreates: [] as AlertCreate[] }
  const prisma = {
    thread: {
      findUnique: async () => ({
        channel: {
          id: 'channel-1',
          organizationId: 'org-1',
          systemChannelType: null,
          agentBindings: [],
          members: input.members.map((member) => ({ user: member })),
        },
      }),
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'message-1',
        threadId: data['threadId'],
        agentId: null,
        userId: data['userId'],
        role: 'user',
        content: data['content'],
        metadata: data['metadata'],
        createdAt: new Date('2026-07-24T12:00:00.000Z'),
        editedAt: null,
        deletedAt: null,
        reactions: [],
        user: {
          id: data['userId'],
          email: 'author@example.com',
          displayName: 'Author One',
          avatarUrl: null,
          avatarAttachmentId: null,
        },
      }),
      update: async () => {
        throw new Error('no agent mentions expected in these fixtures')
      },
    },
    agent: {
      findMany: async () => [],
    },
    userAlert: {
      createMany: async ({ data }: { data: AlertCreate[] }) => {
        calls.alertCreates.push(...data)
        return { count: data.length }
      },
    },
    messageThreadFollow: {
      createMany: async () => ({ count: 0 }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  } as unknown as PrismaClient
  return { prisma, calls }
}

const members = [
  { id: 'user-1', displayName: 'Author One' },
  { id: 'user-2', displayName: 'Mentioned One' },
  { id: 'user-3', displayName: 'Mentioned Two' },
]

test('createThreadMessage writes a mention alert row per mentioned member, skipping the author', async () => {
  const { prisma, calls } = makeMessagePrisma({ members })

  const result = await createThreadMessage(prisma, {
    content: '@Mentioned One @Mentioned Two @Author One standup in five',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return

  // The self-mention (@Author One) creates no row.
  assert.deepEqual(
    calls.alertCreates.map((alert) => alert.userId).sort(),
    ['user-2', 'user-3'],
  )
  for (const alert of calls.alertCreates) {
    assert.equal(alert.organizationId, 'org-1')
    assert.equal(alert.kind, 'mention')
    assert.equal(alert.messageId, 'message-1')
    assert.equal(alert.threadId, 'thread-1')
    assert.equal(alert.channelId, 'channel-1')
    assert.equal(alert.actorUserId, 'user-1')
    assert.equal(alert.actorAgentId, null)
  }
  assert.deepEqual(result.alertedUserIds.sort(), ['user-2', 'user-3'])
})

test('createThreadMessage writes no alert rows for a broadcast mention', async () => {
  const { prisma, calls } = makeMessagePrisma({ members })

  const result = await createThreadMessage(prisma, {
    content: '@channel hello everyone',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  assert.equal(calls.alertCreates.length, 0)
  if (result.kind !== 'created') return
  assert.deepEqual(result.alertedUserIds, [])
})

test('createThreadMessage writes no alert rows when nobody is mentioned', async () => {
  const { prisma, calls } = makeMessagePrisma({ members })

  const result = await createThreadMessage(prisma, {
    content: 'plain message, no mentions',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  assert.equal(calls.alertCreates.length, 0)
})

// ─── listUserAlerts / markUserAlertsRead ─────────────────────────────────────

const ALERT_1 = '00000000-0000-4000-8000-000000000101'
const ALERT_2 = '00000000-0000-4000-8000-000000000102'
const ALERT_3 = '00000000-0000-4000-8000-000000000103'
const ALERT_FOREIGN = '00000000-0000-4000-8000-000000000104'

// Seeded newest-first so the (ordering-agnostic) store slices pages the same
// way the real orderBy would.
const seedAlerts = (store: TenantStore) =>
  {
    store.seed('user', [{ id: 'user-1' }])
    store.seed('organizationMember', [
      { id: 'org-member-1', organizationId: 'org-1', userId: 'user-1', deactivatedAt: null },
    ])
    store.seed('channel', [
      { id: 'channel-1', organizationId: 'org-1' },
      { id: 'channel-2', organizationId: 'org-1' },
    ])
    store.seed('channelMember', [
      { id: 'channel-member-1', channelId: 'channel-1', userId: 'user-1' },
      { id: 'channel-member-2', channelId: 'channel-2', userId: 'user-1' },
    ])
    return store.seed('userAlert', [
    {
      id: ALERT_1,
      organizationId: 'org-1',
      userId: 'user-1',
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: 'channel-1',
      actorUserId: 'user-9',
      actorAgentId: null,
      readAt: null,
      createdAt: new Date('2026-07-24T12:00:00.000Z'),
    },
    {
      id: ALERT_2,
      organizationId: 'org-1',
      userId: 'user-1',
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: 'channel-2',
      actorUserId: null,
      actorAgentId: 'agent-1',
      readAt: null,
      createdAt: new Date('2026-07-24T11:00:00.000Z'),
    },
    {
      id: ALERT_3,
      organizationId: 'org-1',
      userId: 'user-1',
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: 'channel-1',
      actorUserId: 'user-9',
      actorAgentId: null,
      readAt: new Date('2026-07-24T10:30:00.000Z'),
      createdAt: new Date('2026-07-24T10:00:00.000Z'),
    },
    // Same user id, different org — must never leak into org-1 reads.
    {
      id: ALERT_FOREIGN,
      organizationId: 'org-2',
      userId: 'user-1',
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: 'channel-9',
      actorUserId: null,
      actorAgentId: null,
      readAt: null,
      createdAt: new Date('2026-07-24T13:00:00.000Z'),
    },
    ])
  }

test('listUserAlerts returns only the caller org+user alerts with the unread count', async () => {
  const store = new TenantStore()
  seedAlerts(store)

  const result = await listUserAlerts(store.client, {
    organizationId: 'org-1',
    userId: 'user-1',
  })

  assert.equal(result.data.alerts.length, 3)
  assert.equal(result.data.unreadCount, 2)
  assert.ok(!result.data.alerts.some((alert) => alert.id === ALERT_FOREIGN))
  assert.equal(result.meta.hasMore, false)
  assert.equal(result.meta.nextCursor, null)
})

test('listUserAlerts unread filter returns only unread alerts', async () => {
  const store = new TenantStore()
  seedAlerts(store)

  const result = await listUserAlerts(store.client, {
    organizationId: 'org-1',
    userId: 'user-1',
    unreadOnly: true,
  })

  assert.deepEqual(
    result.data.alerts.map((alert) => alert.id),
    [ALERT_1, ALERT_2],
  )
  assert.equal(result.data.unreadCount, 2)
})

test('listUserAlerts paginates with a keyset cursor', async () => {
  const store = new TenantStore()
  seedAlerts(store)

  const page1 = await listUserAlerts(store.client, {
    organizationId: 'org-1',
    userId: 'user-1',
    limit: 2,
  })
  assert.equal(page1.data.alerts.length, 2)
  assert.equal(page1.meta.hasMore, true)
  assert.ok(page1.meta.nextCursor)

  const page2 = await listUserAlerts(store.client, {
    organizationId: 'org-1',
    userId: 'user-1',
    limit: 2,
    cursor: page1.meta.nextCursor ?? undefined,
  })
  assert.equal(page2.data.alerts.length, 1)
  assert.equal(page2.data.alerts[0]?.id, ALERT_3)
  assert.equal(page2.meta.hasMore, false)
})

test('markUserAlertsRead marks only the requested ids of the caller', async () => {
  const store = new TenantStore()
  seedAlerts(store)

  const result = await markUserAlertsRead(store.client, {
    organizationId: 'org-1',
    userId: 'user-1',
    ids: [ALERT_1],
  })

  assert.equal(result.read, 1)
  assert.equal(result.unreadCount, 1)
  assert.deepEqual(
    result.readAlerts.map(({ id, channelId }) => ({ id, channelId })),
    [{ id: ALERT_1, channelId: 'channel-1' }],
  )
  const rows = store.rows('userAlert')
  assert.ok(rows.find((row) => row['id'] === ALERT_1)?.['readAt'] instanceof Date)
  assert.equal(rows.find((row) => row['id'] === ALERT_2)?.['readAt'], null)
  assert.equal(rows.find((row) => row['id'] === ALERT_FOREIGN)?.['readAt'], null)
})

test('markUserAlertsRead all:true marks every unread alert of the caller only', async () => {
  const store = new TenantStore()
  seedAlerts(store)

  const result = await markUserAlertsRead(store.client, {
    organizationId: 'org-1',
    userId: 'user-1',
    all: true,
  })

  assert.equal(result.read, 2)
  assert.equal(result.unreadCount, 0)
  const rows = store.rows('userAlert')
  assert.ok(rows.find((row) => row['id'] === ALERT_2)?.['readAt'] instanceof Date)
  // The foreign-org row stays unread.
  assert.equal(rows.find((row) => row['id'] === ALERT_FOREIGN)?.['readAt'], null)
})

// ─── HTTP routes: validation, response shape, realtime fan-out ──────────────

const ROUTE_ORG = '00000000-0000-4000-8000-000000000201'
const ROUTE_USER = '00000000-0000-4000-8000-000000000202'
const ROUTE_CHANNEL_1 = '00000000-0000-4000-8000-000000000203'
const ROUTE_CHANNEL_2 = '00000000-0000-4000-8000-000000000204'
const ROUTE_ALERT_1 = '00000000-0000-4000-8000-000000000205'
const ROUTE_ALERT_2 = '00000000-0000-4000-8000-000000000206'

const seedRouteAlerts = (store: TenantStore) =>
  {
    store.seed('user', [{ id: ROUTE_USER }])
    store.seed('organizationMember', [
      { id: 'route-org-member', organizationId: ROUTE_ORG, userId: ROUTE_USER, deactivatedAt: null },
    ])
    store.seed('channel', [
      { id: ROUTE_CHANNEL_1, organizationId: ROUTE_ORG },
      { id: ROUTE_CHANNEL_2, organizationId: ROUTE_ORG },
    ])
    store.seed('channelMember', [
      { id: 'route-channel-member-1', channelId: ROUTE_CHANNEL_1, userId: ROUTE_USER },
      { id: 'route-channel-member-2', channelId: ROUTE_CHANNEL_2, userId: ROUTE_USER },
    ])
    return store.seed('userAlert', [
    {
      id: ROUTE_ALERT_1,
      organizationId: ROUTE_ORG,
      userId: ROUTE_USER,
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: ROUTE_CHANNEL_1,
      actorUserId: null,
      actorAgentId: null,
      readAt: null,
      createdAt: new Date('2026-07-24T12:00:00.000Z'),
    },
    {
      id: ROUTE_ALERT_2,
      organizationId: ROUTE_ORG,
      userId: ROUTE_USER,
      kind: 'mention',
      messageId: null,
      threadId: null,
      channelId: ROUTE_CHANNEL_2,
      actorUserId: null,
      actorAgentId: null,
      readAt: null,
      createdAt: new Date('2026-07-24T11:00:00.000Z'),
    },
    ])
  }

const makeAlertsApp = (
  store: TenantStore,
  published?: { event: string; data: unknown }[],
) => {
  const app = Fastify({ logger: false })
  app.decorateRequest('actorContext', null)
  app.addHook('onRequest', (request, _reply, done) => {
    ;(request as { actorContext: unknown }).actorContext = actorContext({
      organizationId: ROUTE_ORG,
      userId: ROUTE_USER,
    })
    done()
  })
  const deps = buildDeps(store)
  if (published) {
    deps.realtimeHub = {
      ...deps.realtimeHub,
      publishWs: async (_scopes: unknown, input: { event: string; data: unknown }) => {
        published.push(input)
        return undefined
      },
    } as unknown as typeof deps.realtimeHub
  }
  registerAlertRoutes(app, deps)
  return app
}

test('GET /api/alerts returns the alerts envelope with unread count and meta', async () => {
  const store = new TenantStore()
  seedRouteAlerts(store)
  const app = makeAlertsApp(store)

  const res = await app.inject({ method: 'GET', url: '/api/alerts' })

  assert.equal(res.statusCode, 200)
  const body = res.json() as {
    data: { alerts: { id: string }[]; unreadCount: number }
    meta: { hasMore: boolean }
  }
  assert.equal(body.data.alerts.length, 2)
  assert.equal(body.data.unreadCount, 2)
  assert.equal(body.meta.hasMore, false)
  await app.close()
})

test('GET /api/alerts?unread=true filters to unread alerts', async () => {
  const store = new TenantStore()
  seedRouteAlerts(store)
  store.rows('userAlert')[0]!['readAt'] = new Date('2026-07-24T12:30:00.000Z')
  const app = makeAlertsApp(store)

  const res = await app.inject({ method: 'GET', url: '/api/alerts?unread=true' })

  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: { alerts: { id: string }[]; unreadCount: number } }
  assert.deepEqual(
    body.data.alerts.map((alert) => alert.id),
    [ROUTE_ALERT_2],
  )
  assert.equal(body.data.unreadCount, 1)
  await app.close()
})

test('GET /api/alerts rejects a non-positive limit', async () => {
  const store = new TenantStore()
  const app = makeAlertsApp(store)

  const res = await app.inject({ method: 'GET', url: '/api/alerts?limit=0' })

  assert.equal(res.statusCode, 400)
  await app.close()
})

test('POST /api/alerts/read requires ids or all', async () => {
  const store = new TenantStore()
  const app = makeAlertsApp(store)

  const res = await app.inject({ method: 'POST', url: '/api/alerts/read', payload: {} })

  assert.equal(res.statusCode, 400)
  assert.equal((res.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR')
  await app.close()
})

test('POST /api/alerts/read all:true marks read and fans out one alert.read per channel', async () => {
  const store = new TenantStore()
  seedRouteAlerts(store)
  const published: { event: string; data: unknown }[] = []
  const app = makeAlertsApp(store, published)

  const res = await app.inject({
    method: 'POST',
    url: '/api/alerts/read',
    payload: { all: true },
  })

  assert.equal(res.statusCode, 200)
  const body = res.json() as { data: { read: number; unreadCount: number } }
  assert.equal(body.data.read, 2)
  assert.equal(body.data.unreadCount, 0)

  const readEvents = published.filter((entry) => entry.event === 'alert.read')
  assert.equal(readEvents.length, 2)
  const byChannel = new Map(
    readEvents.map((entry) => [
      (entry.data as { channelId: string }).channelId,
      entry.data as { userId: string; alertIds: string[] },
    ]),
  )
  assert.deepEqual(byChannel.get(ROUTE_CHANNEL_1)?.alertIds, [ROUTE_ALERT_1])
  assert.deepEqual(byChannel.get(ROUTE_CHANNEL_2)?.alertIds, [ROUTE_ALERT_2])
  for (const data of byChannel.values()) {
    assert.equal(data.userId, ROUTE_USER)
  }
  await app.close()
})
