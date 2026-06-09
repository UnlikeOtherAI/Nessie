import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  isUserActive,
  markConnected,
  markDisconnected,
  touch,
} from '../src/services/presence.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const staleUserId = '00000000-0000-4000-8000-000000000003'
const zeroConnectionUserId = '00000000-0000-4000-8000-000000000004'

type PresenceRow = {
  userId: string
  organizationId: string
  connections: number
  lastSeenAt: Date
  updatedAt: Date
}

type UpsertArgs = {
  where: { userId: string }
  create: Omit<PresenceRow, 'updatedAt'>
  update: {
    organizationId: string
    connections: { increment: number }
    lastSeenAt: Date
  }
}

type UpdateManyArgs = {
  where: {
    userId: string
    connections?: { gt: number }
  }
  data: {
    connections?: { decrement: number }
    lastSeenAt?: Date
  }
}

type FindFirstArgs = {
  where: {
    userId: string
    connections: { gt: number }
    lastSeenAt: { gte: Date }
  }
  select: { userId: true }
}

const makePresencePrisma = (rows: PresenceRow[] = []) => {
  const prisma = {
    userPresence: {
      upsert: async ({ where, create, update }: UpsertArgs): Promise<PresenceRow> => {
        const existing = rows.find((row) => row.userId === where.userId)
        if (existing) {
          existing.organizationId = update.organizationId
          existing.connections += update.connections.increment
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
          if (where.connections && row.connections <= where.connections.gt) {
            continue
          }

          if (data.connections) {
            row.connections = Math.max(row.connections - data.connections.decrement, 0)
          }
          if (data.lastSeenAt) {
            row.lastSeenAt = data.lastSeenAt
          }
          row.updatedAt = new Date()
          count += 1
        }
        return { count }
      },
      findFirst: async ({ where }: FindFirstArgs): Promise<{ userId: string } | null> => {
        const row = rows.find(
          (candidate) =>
            candidate.userId === where.userId
            && candidate.connections > where.connections.gt
            && candidate.lastSeenAt.getTime() >= where.lastSeenAt.gte.getTime(),
        )

        return row ? { userId: row.userId } : null
      },
    },
  } as unknown as PrismaClient

  return { prisma, rows }
}

test('markConnected increments and markDisconnected floors at zero', async () => {
  const { prisma, rows } = makePresencePrisma()

  await markConnected(prisma, userId, organizationId)
  await markConnected(prisma, userId, organizationId)
  assert.equal(rows[0]?.connections, 2)

  await markDisconnected(prisma, userId)
  assert.equal(rows[0]?.connections, 1)

  await markDisconnected(prisma, userId)
  await markDisconnected(prisma, userId)
  assert.equal(rows[0]?.connections, 0)
})

test('touch refreshes lastSeenAt without creating absent presence rows', async () => {
  const oldSeenAt = new Date(Date.now() - 60_000)
  const { prisma, rows } = makePresencePrisma([
    {
      userId,
      organizationId,
      connections: 1,
      lastSeenAt: oldSeenAt,
      updatedAt: oldSeenAt,
    },
  ])

  await touch(prisma, userId)
  await touch(prisma, staleUserId)

  assert.equal(rows.length, 1)
  assert.ok(rows[0] && rows[0].lastSeenAt.getTime() >= oldSeenAt.getTime())
})

test('isUserActive requires a positive connection count and recent heartbeat', async () => {
  const now = Date.now()
  const { prisma } = makePresencePrisma([
    {
      userId,
      organizationId,
      connections: 1,
      lastSeenAt: new Date(now - 1_000),
      updatedAt: new Date(now - 1_000),
    },
    {
      userId: staleUserId,
      organizationId,
      connections: 1,
      lastSeenAt: new Date(now - 60_000),
      updatedAt: new Date(now - 60_000),
    },
    {
      userId: zeroConnectionUserId,
      organizationId,
      connections: 0,
      lastSeenAt: new Date(now - 1_000),
      updatedAt: new Date(now - 1_000),
    },
  ])

  assert.equal(await isUserActive(prisma, userId, 30_000), true)
  assert.equal(await isUserActive(prisma, staleUserId, 30_000), false)
  assert.equal(await isUserActive(prisma, zeroConnectionUserId, 30_000), false)
})
