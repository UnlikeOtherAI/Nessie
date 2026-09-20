import assert from 'node:assert/strict'
import test from 'node:test'

import { sweepExpiredLocalInferenceTransport } from '../src/services/local-inference-transport-sweep.js'

test('transport maintenance expires a disconnected host attempt before bounded deletion', async () => {
  let expiryWhere: unknown
  let frameWhere: unknown
  let attemptWhere: unknown
  const prisma = {
    localInferenceAttempt: {
      deleteMany: async ({ where }: { where: unknown }) => { attemptWhere = where },
      findMany: async () => [{ id: 'terminal-attempt' }],
      updateMany: async ({ where }: { where: unknown }) => { expiryWhere = where },
    },
    localInferenceFrame: {
      deleteMany: async ({ where }: { where: unknown }) => { frameWhere = where },
    },
  }
  await sweepExpiredLocalInferenceTransport(prisma as never, new Date('2026-09-20T12:00:00.000Z'))
  assert.deepEqual(expiryWhere, {
    deadlineAt: { lte: new Date('2026-09-20T12:00:00.000Z') },
    state: { in: ['queued', 'leased', 'accepted'] },
  })
  assert.deepEqual(frameWhere, {
    OR: [
      { acknowledgedAt: { lte: new Date('2026-09-20T11:00:00.000Z') } },
      { attemptId: { in: ['terminal-attempt'] } },
    ],
  })
  assert.deepEqual(attemptWhere, { id: { in: ['terminal-attempt'] } })
})
