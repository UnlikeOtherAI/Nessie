import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { recordPushSurfacePresence } from '../src/services/push-surface-presence.js'

// Integration test against the local Postgres (see AGENTS.md). The push-surface
// heartbeat upsert must survive an out-of-order or concurrent heartbeat for the
// same (userId, clientId) without 500ing. The pre-fix code did a read
// (`updateMany`) then a conditional `create`; when the row already existed with
// a strictly newer sequence the `updateMany` matched nothing, the `create`
// raised a unique violation (P2002), and the recovery `updateMany` then ran
// inside a transaction Postgres had already aborted (25P02) — so the request
// 500'd. A unit-level mock could not catch it because it does not model
// transaction-abort semantics; only a real database does.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  userId: string
  sessionId: string
  clientId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({
    data: { name: `push-presence ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { email: `push-${randomUUID()}@example.test`, displayName: 'Heartbeat' },
  })
  const sessionId = randomUUID()
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      familyId: randomUUID(),
      sessionId,
      providerId: 'local',
      providerType: 'password',
      tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  })
  return {
    organizationId: org.id,
    userId: user.id,
    sessionId,
    clientId: randomUUID(),
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.userPushSurfacePresence.deleteMany({ where: { userId: s.userId } })
  await prisma.refreshToken.deleteMany({ where: { userId: s.userId } })
  await prisma.user.deleteMany({ where: { id: s.userId } })
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
}

const heartbeat = (prisma: PrismaClient, s: Seed, sequence: bigint) =>
  recordPushSurfacePresence(prisma, {
    clientId: s.clientId,
    organizationId: s.organizationId,
    sequence,
    sessionId: s.sessionId,
    surface: null,
    userId: s.userId,
  })

runDatabaseTest(
  'a stale heartbeat after a newer one resolves instead of aborting the transaction',
  async () => {
    const prisma = new PrismaClient()
    const s = await seed(prisma)
    try {
      // Establish the row at a newer sequence, then replay an older one. The
      // pre-fix path threw `25P02` here; the ON CONFLICT upsert simply no-ops.
      await heartbeat(prisma, s, 2n)
      await assert.doesNotReject(heartbeat(prisma, s, 1n))

      const row = await prisma.userPushSurfacePresence.findFirst({
        where: { userId: s.userId, clientId: s.clientId },
        select: { heartbeatSequence: true },
      })
      // The stale heartbeat must not roll the sequence backwards.
      assert.equal(row?.heartbeatSequence, 2n)
    } finally {
      await cleanup(prisma, s)
      await prisma.$disconnect()
    }
  },
)

runDatabaseTest(
  'two concurrent heartbeats for the same (userId, clientId) both succeed',
  async () => {
    const prisma = new PrismaClient()
    const s = await seed(prisma)
    try {
      // Fire a burst that mixes ascending and descending sequences for the one
      // row. Under the per-user advisory lock these serialize in an arbitrary
      // order, so at least one lands as a stale write against an existing row —
      // the exact shape that used to 500. Every one must resolve.
      const results = await Promise.allSettled([
        heartbeat(prisma, s, 1n),
        heartbeat(prisma, s, 3n),
        heartbeat(prisma, s, 2n),
        heartbeat(prisma, s, 4n),
      ])
      const rejected = results.filter((r) => r.status === 'rejected')
      assert.deepEqual(rejected, [])

      const row = await prisma.userPushSurfacePresence.findFirst({
        where: { userId: s.userId, clientId: s.clientId },
        select: { heartbeatSequence: true },
      })
      // The monotonic predicate keeps the highest sequence regardless of the
      // order the concurrent writes committed in.
      assert.equal(row?.heartbeatSequence, 4n)
    } finally {
      await cleanup(prisma, s)
      await prisma.$disconnect()
    }
  },
)
