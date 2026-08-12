import assert from 'node:assert/strict'
import test from 'node:test'

import { PushSurfaceSchema } from '@nessie/schemas'

import {
  clearPushSurfacePresenceForUser,
  recordPushSurfacePresence,
  sweepStalePushSurfacePresence,
} from '../src/services/push-surface-presence.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const phoneClientId = '00000000-0000-4000-8000-000000000003'
const tabletClientId = '00000000-0000-4000-8000-000000000004'
const channelId = '00000000-0000-4000-8000-000000000005'
const projectId = '00000000-0000-4000-8000-000000000007'
const sessionId = '00000000-0000-4000-8000-000000000006'
const threadId = '00000000-0000-4000-8000-000000000008'

const pushSurfaceStore = (rows: Map<string, Record<string, unknown>>) => ({
  updateMany: async ({ data, where }: {
    data: Record<string, unknown>
    where: {
      clientId: string
      heartbeatSequence: { lte: bigint }
      userId: string
    }
  }) => {
    const key = `${where.userId}:${where.clientId}`
    const existing = rows.get(key)
    if (
      !existing
      || typeof existing.heartbeatSequence !== 'bigint'
      || existing.heartbeatSequence > where.heartbeatSequence.lte
    ) {
      return { count: 0 }
    }
    rows.set(key, { ...existing, ...data })
    return { count: 1 }
  },
  create: async ({ data }: { data: Record<string, unknown> }) => {
    const key = `${data.userId}:${data.clientId}`
    if (rows.has(key)) {
      throw Object.assign(new Error('duplicate push surface'), { code: 'P2002' })
    }
    rows.set(key, data)
    return data
  },
})

const withSession = <T extends object>(transaction: T, active = true) => ({
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
    ...transaction,
    $queryRaw: async () => [{ locked: true }],
    refreshToken: {
      findFirst: async () => (active ? { id: 'refresh-token-1' } : null),
    },
  }),
})

const exactThread = {
  findFirst: async ({ where }: { where: { channelId: string; id: string } }) =>
    where.channelId === channelId && where.id === threadId ? { id: threadId } : null,
}

test('records each app session separately so only an exact open thread can suppress its push', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: {
      findFirst: async ({ where }: { where: { channelId: string; userId: string } }) =>
        where.channelId === channelId && where.userId === userId ? { id: 'member-1' } : null,
    },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  })
  const channel = PushSurfaceSchema.parse({ kind: 'channel', channelId, threadId })

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: channel,
    userId,
  })
  await recordPushSurfacePresence(prisma as never, {
    clientId: tabletClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: { kind: 'ops_usage' },
    userId,
  })

  assert.equal(rows.size, 2)
  assert.equal(rows.get(`${userId}:${phoneClientId}`)?.channelId, channelId)
  assert.equal(rows.get(`${userId}:${phoneClientId}`)?.threadId, threadId)
  assert.equal(rows.get(`${userId}:${tabletClientId}`)?.surfaceKind, 'ops_usage')
})

test('clears an unentitled channel target instead of persisting a cross-organization surface', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => null },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  })

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({
      kind: 'channel',
      channelId: '00000000-0000-4000-8000-000000000006',
      threadId,
    }),
    userId,
  })

  const created = rows.get(`${userId}:${phoneClientId}`)
  assert.equal(created?.surfaceKind, null)
  assert.equal(created?.channelId, null)
})

test('clears a thread that does not belong to the reported channel', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => ({ id: 'member-1' }) },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  })

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({
      channelId,
      kind: 'channel',
      threadId: '00000000-0000-4000-8000-000000000009',
    }),
    userId,
  })

  const created = rows.get(`${userId}:${phoneClientId}`)
  assert.equal(created?.surfaceKind, null)
  assert.equal(created?.threadId, null)
})

test('records a project Board only after checking the recipient can reach that project', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => null },
    projectMember: { findFirst: async () => ({ id: 'project-member-1' }) },
    organizationMember: { findFirst: async () => ({ id: 'member-1' }) },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  })
  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'project_board', projectId }),
    userId,
  })
  const created = rows.get(`${userId}:${phoneClientId}`)
  assert.equal(created?.surfaceKind, 'project_board')
  assert.equal(created?.projectId, projectId)
  assert.equal(created?.channelId, null)
})

test('clears the Ops usage surface for a non-owner', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => null },
    organizationMember: { findFirst: async () => null },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  })

  await recordPushSurfacePresence(prisma as never, {
    clientId: tabletClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: { kind: 'ops_usage' },
    userId,
  })

  const created = rows.get(`${userId}:${tabletClientId}`)
  assert.equal(created?.surfaceKind, null)
  assert.equal(created?.channelId, null)
})

test('does not let a delayed foreground heartbeat overwrite a newer background signal', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => ({ id: 'member-1' }) },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  })

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 2n,
    sessionId,
    surface: null,
    userId,
  })
  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'channel', channelId, threadId }),
    userId,
  })

  const current = rows.get(`${userId}:${phoneClientId}`)
  assert.equal(current?.surfaceKind, null)
  assert.equal(current?.channelId, null)
  assert.equal(current?.heartbeatSequence, 2n)
})

test('does not recreate a surface for a revoked session access token', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => ({ id: 'member-1' }) },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
    userPushSurfacePresence: pushSurfaceStore(rows),
  }, false)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'channel', channelId, threadId }),
    userId,
  })

  assert.equal(rows.size, 0)
})

test('reaps abandoned sessions after the short retention period', async () => {
  let where: unknown
  const now = new Date('2026-08-11T12:00:00.000Z')
  const prisma = {
    userPushSurfacePresence: {
      deleteMany: async (input: { where: unknown }) => {
        where = input.where
        return { count: 0 }
      },
    },
  }

  await sweepStalePushSurfacePresence(prisma as never, now)

  assert.deepEqual(where, {
    lastSeenAt: { lt: new Date('2026-08-11T11:55:00.000Z') },
  })
})

test('clears every current push surface when the user signs out', async () => {
  let where: unknown
  const prisma = {
    userPushSurfacePresence: {
      deleteMany: async (input: { where: unknown }) => {
        where = input.where
        return { count: 2 }
      },
    },
  }

  await clearPushSurfacePresenceForUser(prisma as never, userId)

  assert.deepEqual(where, { userId })
})
