import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  markConnected,
  resolvePresenceState,
  touch,
} from '../src/services/presence.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const staleUserId = '00000000-0000-4000-8000-000000000003'

type PresenceRow = {
  userId: string
  organizationId: string
  lastSeenAt: Date
  updatedAt: Date
}

type UpsertArgs = {
  where: { userId: string }
  create: Omit<PresenceRow, 'updatedAt'>
  update: {
    organizationId: string
    lastSeenAt: Date
  }
}

type UpdateManyArgs = {
  where: { userId: string }
  data: { lastSeenAt?: Date }
}

const makePresencePrisma = (rows: PresenceRow[] = []) => {
  const prisma = {
    userPresence: {
      upsert: async ({ where, create, update }: UpsertArgs): Promise<PresenceRow> => {
        const existing = rows.find((row) => row.userId === where.userId)
        if (existing) {
          existing.organizationId = update.organizationId
          existing.lastSeenAt = update.lastSeenAt
          existing.updatedAt = new Date()
          return existing
        }

        const created = {
          ...create,
          updatedAt: new Date(),
        }
        rows.push(created)
        return created
      },
      updateMany: async ({ where, data }: UpdateManyArgs): Promise<{ count: number }> => {
        let count = 0
        for (const row of rows) {
          if (row.userId !== where.userId) {
            continue
          }

          if (data.lastSeenAt) {
            row.lastSeenAt = data.lastSeenAt
          }
          row.updatedAt = new Date()
          count += 1
        }
        return { count }
      },
    },
  } as unknown as PrismaClient

  return { prisma, rows }
}

// Opening a second stream must not create a second row, and it must not
// accumulate anything a crashed process would have to decrement back down:
// one row per user, carrying only the heartbeat (audit 2.4).
test('markConnected upserts one row per user and only refreshes the heartbeat', async () => {
  const { prisma, rows } = makePresencePrisma()

  await markConnected(prisma, userId, organizationId)
  const firstSeenAt = rows[0]?.lastSeenAt
  await markConnected(prisma, userId, organizationId)

  assert.equal(rows.length, 1)
  assert.ok(firstSeenAt && rows[0] && rows[0].lastSeenAt.getTime() >= firstSeenAt.getTime())
})

test('touch refreshes lastSeenAt without creating absent presence rows', async () => {
  const oldSeenAt = new Date(Date.now() - 60_000)
  const { prisma, rows } = makePresencePrisma([
    {
      userId,
      organizationId,
      lastSeenAt: oldSeenAt,
      updatedAt: oldSeenAt,
    },
  ])

  await touch(prisma, userId)
  await touch(prisma, staleUserId)

  assert.equal(rows.length, 1)
  assert.ok(rows[0] && rows[0].lastSeenAt.getTime() >= oldSeenAt.getTime())
})

test('resolvePresenceState: stale heartbeat is offline regardless of overrides', () => {
  const now = Date.now()
  const stale = new Date(now - 120_000)
  assert.equal(
    resolvePresenceState({ lastSeenAt: stale, lastActiveAt: stale, manualState: 'active' }, now),
    'offline',
  )
})

test('resolvePresenceState: manual override wins while connected', () => {
  const now = Date.now()
  const fresh = new Date(now - 1_000)
  assert.equal(
    resolvePresenceState({ lastSeenAt: fresh, lastActiveAt: fresh, manualState: 'away' }, now),
    'away',
  )
  assert.equal(
    resolvePresenceState({ lastSeenAt: fresh, lastActiveAt: null, manualState: 'active' }, now),
    'online',
  )
})

test('resolvePresenceState: auto online/away from recent activity', () => {
  const now = Date.now()
  const fresh = new Date(now - 1_000)
  assert.equal(
    resolvePresenceState({ lastSeenAt: fresh, lastActiveAt: fresh, manualState: null }, now),
    'online',
  )
  assert.equal(
    resolvePresenceState(
      { lastSeenAt: fresh, lastActiveAt: new Date(now - 6 * 60_000), manualState: null },
      now,
    ),
    'away',
  )
  assert.equal(
    resolvePresenceState({ lastSeenAt: fresh, lastActiveAt: null, manualState: null }, now),
    'away',
  )
})
