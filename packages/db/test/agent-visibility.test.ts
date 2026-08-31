import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  buildVisibleAgentWhere,
  listVisibleAgentIdsForUser,
} from '../src/agent-visibility.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'

test('buildVisibleAgentWhere centralizes channel reach and live stewardship', () => {
  assert.deepEqual(buildVisibleAgentWhere({ organizationId, userId }), {
    organizationId,
    systemManaged: false,
    OR: [
      {
        bindings: {
          some: {
            channel: {
              organizationId,
              OR: [
                { visibility: 'public' },
                { members: { some: { userId } } },
              ],
            },
          },
        },
      },
      {
        ownerMembership: { deactivatedAt: null },
        ownerUserId: userId,
        parentAgentId: null,
      },
    ],
  })
})

test('listVisibleAgentIdsForUser returns ids from the shared where fragment', async () => {
  const calls: unknown[] = []
  const prisma = {
    agent: {
      findMany: async (args: unknown) => {
        calls.push(args)
        return [{ id: 'agent-1' }, { id: 'agent-2' }]
      },
    },
  } as unknown as PrismaClient

  assert.deepEqual(
    await listVisibleAgentIdsForUser(prisma, { organizationId, userId }),
    ['agent-1', 'agent-2'],
  )
  assert.deepEqual(calls, [{
    select: { id: true },
    where: buildVisibleAgentWhere({ organizationId, userId }),
  }])
})
