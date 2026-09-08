import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  buildAgentVisibilityWhere,
  buildOwnedAgentWhere,
  buildVisibleAgentWhere,
  listVisibleAgentIdsForUser,
} from '../src/agent-visibility.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const agentId = '00000000-0000-4000-8000-000000000003'

test('buildVisibleAgentWhere centralizes channel reach, live stewardship, and private visibility', () => {
  assert.deepEqual(buildVisibleAgentWhere({ organizationId, userId }), {
    organizationId,
    systemManaged: false,
    AND: [
      {
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
          buildOwnedAgentWhere({ organizationId, userId }),
        ],
      },
      buildAgentVisibilityWhere({ organizationId, userId }),
    ],
  })
})

test('a fresh UOA owner keeps unbound and directly granted agent reach', () => {
  const where = buildVisibleAgentWhere({
    organizationId,
    uoaMembershipVerified: true,
    userId,
  })

  const owned = where.AND?.[0]
  assert.deepEqual(owned, {
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
      { ownerUserId: userId, parentAgentId: null },
    ],
  })
  assert.equal(JSON.stringify(where).includes('teamId'), false)
})

test('a stale local owner row cannot stand in for a fresh UOA proof', () => {
  assert.deepEqual(buildOwnedAgentWhere({ organizationId, userId }), {
    ownerMembership: { deactivatedAt: null },
    ownerUserId: userId,
    parentAgentId: null,
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
