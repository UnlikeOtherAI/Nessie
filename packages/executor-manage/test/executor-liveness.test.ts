import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import {
  EXECUTOR_HEARTBEAT_FRESHNESS_MS,
  executorHeartbeatCutoff,
  expireStaleExecutorHeartbeats,
} from '../src/index.js'

test('executor liveness uses one sixty-second cutoff and persists offline', async () => {
  const now = new Date('2026-08-12T12:00:00.000Z')
  let update: Record<string, unknown> | undefined
  const prisma = {
    executor: {
      updateMany: async (input: Record<string, unknown>) => {
        update = input
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient

  assert.equal(EXECUTOR_HEARTBEAT_FRESHNESS_MS, 60_000)
  assert.equal(executorHeartbeatCutoff(now).toISOString(), '2026-08-12T11:59:00.000Z')
  assert.equal(
    await expireStaleExecutorHeartbeats(
      prisma,
      { executorId: '00000000-0000-4000-8000-000000000001' },
      now,
    ),
    1,
  )
  assert.deepEqual(update, {
    data: {
      status: 'offline',
      statusDetail: 'Executor heartbeat expired.',
    },
    where: {
      id: '00000000-0000-4000-8000-000000000001',
      OR: [
        { lastSeenAt: null },
        { lastSeenAt: { lt: new Date('2026-08-12T11:59:00.000Z') } },
      ],
      status: 'online',
    },
  })
})
