import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { resolveStaleGmailDispatches } from '../src/gmail-draft-dispatch.js'

test('stale Gmail claims return only transitions won by this sweep', async () => {
  const staleAt = new Date('2026-09-02T09:58:00.000Z')
  const candidates = [
    { id: 'action-1', organizationId: 'organization-1' },
    { id: 'action-2', organizationId: 'organization-2' },
  ]
  const writes: string[] = []
  const prisma = {
    gmailDraftAction: {
      findMany: async (input: { take: number }) => {
        assert.equal(input.take, 50)
        return candidates
      },
      updateMany: async (input: {
        data: { state: string }
        where: { claimedAt: { lt: Date }; id: string }
      }) => {
        assert.deepEqual(input.where.claimedAt, { lt: staleAt })
        if (input.where.id === 'action-2') return { count: 0 }
        writes.push(input.where.id)
        assert.equal(input.data.state, 'delivery_unknown')
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient

  const resolved = await resolveStaleGmailDispatches(prisma, {
    now: () => new Date('2026-09-02T10:00:00.000Z'),
  })

  assert.deepEqual(resolved, [candidates[0]])
  assert.deepEqual(writes, ['action-1'])
})
