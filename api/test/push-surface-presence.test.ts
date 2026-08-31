import assert from 'node:assert/strict'
import test from 'node:test'

import { visibleKnowledgeSpaceWhere } from '@nessie/db'
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
const rootMessageId = '00000000-0000-4000-8000-000000000010'
const knowledgeSpaceId = '00000000-0000-4000-8000-000000000011'

// Model Postgres `INSERT ... ON CONFLICT (user_id, client_id) DO UPDATE ...
// WHERE existing.heartbeat_sequence <= EXCLUDED.heartbeat_sequence`. The row is
// created when absent and only advanced when the incoming heartbeat is at least
// as recent, exactly as the single `$executeRaw` in the service does. The
// positional order mirrors that statement's VALUES list; a reorder there fails
// these assertions loudly rather than silently.
const applyUpsert = (
  rows: Map<string, Record<string, unknown>>,
  values: unknown[],
): number => {
  const [
    userId,
    organizationId,
    clientId,
    surfaceKind,
    channelId,
    threadId,
    rootMessageId,
    projectId,
    knowledgeSpaceId,
    heartbeatSequence,
    lastSeenAt,
  ] = values
  const key = `${String(userId)}:${String(clientId)}`
  const existing = rows.get(key)
  if (
    existing
    && typeof existing.heartbeatSequence === 'bigint'
    && typeof heartbeatSequence === 'bigint'
    && existing.heartbeatSequence > heartbeatSequence
  ) {
    return 0
  }
  rows.set(key, {
    userId,
    organizationId,
    clientId,
    surfaceKind,
    channelId,
    threadId,
    rootMessageId,
    projectId,
    knowledgeSpaceId,
    heartbeatSequence,
    lastSeenAt,
  })
  return 1
}

const withSession = <T extends object>(
  transaction: T,
  rows: Map<string, Record<string, unknown>>,
  active = true,
) => ({
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
    ...transaction,
    $queryRaw: async () => [{ locked: true }],
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      applyUpsert(rows, values),
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
  }, rows)
  const channel = PushSurfaceSchema.parse({ kind: 'channel', channelId, rootMessageId: null, threadId })

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
  assert.equal(rows.get(`${userId}:${phoneClientId}`)?.rootMessageId, null)
  assert.equal(rows.get(`${userId}:${tabletClientId}`)?.surfaceKind, 'ops_usage')
})

test('treats an older channel heartbeat without a reply root as the main feed', () => {
  assert.equal(
    PushSurfaceSchema.parse({ kind: 'channel', channelId, threadId }).rootMessageId,
    null,
  )
})

test('clears an unentitled channel target instead of persisting a cross-organization surface', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => null },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
  }, rows)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({
      kind: 'channel',
      channelId: '00000000-0000-4000-8000-000000000006',
      rootMessageId: null,
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
  }, rows)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({
      channelId,
      kind: 'channel',
      rootMessageId: null,
      threadId: '00000000-0000-4000-8000-000000000009',
    }),
    userId,
  })

  const created = rows.get(`${userId}:${phoneClientId}`)
  assert.equal(created?.surfaceKind, null)
  assert.equal(created?.threadId, null)
})

test('records a reply conversation only when its root belongs to the reported thread', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => ({ id: 'member-1' }) },
    message: {
      findFirst: async ({ where }: { where: { id: string; rootMessageId: null; threadId: string } }) =>
        where.id === rootMessageId && where.rootMessageId === null && where.threadId === threadId
          ? { id: rootMessageId }
          : null,
    },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
  }, rows)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'channel', channelId, rootMessageId, threadId }),
    userId,
  })

  assert.equal(rows.get(`${userId}:${phoneClientId}`)?.rootMessageId, rootMessageId)
})

test('records a project Board only after checking the recipient can reach that project', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => null },
    projectMember: { findFirst: async () => ({ id: 'project-member-1' }) },
    organizationMember: { findFirst: async () => ({ id: 'member-1' }) },
    thread: exactThread,
  }, rows)
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
  }, rows)

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

test('records an agent-owned knowledge space for a viewer who can see its owning agent', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  let knowledgeSpaceWhere: unknown
  const prisma = withSession({
    knowledgeSpace: {
      findFirst: async ({ where }: { where: unknown }) => {
        knowledgeSpaceWhere = where
        return { id: knowledgeSpaceId }
      },
    },
  }, rows)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'knowledge_space', spaceId: knowledgeSpaceId }),
    userId,
  })

  assert.deepEqual(knowledgeSpaceWhere, {
    id: knowledgeSpaceId,
    ...visibleKnowledgeSpaceWhere({ organizationId, userId }),
  })
  assert.equal(rows.get(`${userId}:${phoneClientId}`)?.knowledgeSpaceId, knowledgeSpaceId)
})

test('clears an agent-owned knowledge space for a viewer who cannot see its owning agent', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  let knowledgeSpaceWhere: unknown
  const prisma = withSession({
    knowledgeSpace: {
      findFirst: async ({ where }: { where: unknown }) => {
        knowledgeSpaceWhere = where
        return null
      },
    },
  }, rows)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'knowledge_space', spaceId: knowledgeSpaceId }),
    userId,
  })

  assert.deepEqual(knowledgeSpaceWhere, {
    id: knowledgeSpaceId,
    ...visibleKnowledgeSpaceWhere({ organizationId, userId }),
  })
  assert.equal(rows.get(`${userId}:${phoneClientId}`)?.surfaceKind, null)
})

test('does not let a delayed foreground heartbeat overwrite a newer background signal', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = withSession({
    channelMember: { findFirst: async () => ({ id: 'member-1' }) },
    organizationMember: { findFirst: async () => ({ id: 'owner-1' }) },
    thread: exactThread,
  }, rows)

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
    surface: PushSurfaceSchema.parse({ kind: 'channel', channelId, rootMessageId: null, threadId }),
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
  }, rows, false)

  await recordPushSurfacePresence(prisma as never, {
    clientId: phoneClientId,
    organizationId,
    sequence: 1n,
    sessionId,
    surface: PushSurfaceSchema.parse({ kind: 'channel', channelId, rootMessageId: null, threadId }),
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
