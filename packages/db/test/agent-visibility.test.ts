import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  buildVisibleAgentWhere,
  listVisibleAgentIdsForUser,
} from '../src/agent-visibility.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const agentId = '00000000-0000-4000-8000-000000000003'

test('buildVisibleAgentWhere owns the channel and live-steward visibility rule', () => {
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

test('listVisibleAgentIdsForUser resolves ids with the shared where fragment', async () => {
  let received: unknown
  const prisma = {
    agent: {
      findMany: async (args: unknown) => {
        received = args
        return [{ id: agentId }]
      },
    },
  } as unknown as PrismaClient

  assert.deepEqual(
    await listVisibleAgentIdsForUser(prisma, { organizationId, userId }),
    [agentId],
  )
  assert.deepEqual(received, {
    where: buildVisibleAgentWhere({ organizationId, userId }),
    select: { id: true },
  })
})
