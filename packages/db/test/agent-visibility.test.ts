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
    // A soft-deleted agent is excluded for everybody, owner included. The row
    // survives for audit history; every capability it had was revoked by
    // `DELETE /api/agents/:agentId`, and this is what keeps it out of the list
    // — and, through `knowledge-space-visibility.ts`, out of knowledge reads.
    deletedAt: null,
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

/**
 * The soft delete, stated as its own case rather than only as a key in the
 * shape above: an agent's rows are kept and it must still be invisible.
 * `buildVisibleAgentWhere` is the single predicate every agent list composes,
 * so the filter belongs here and nowhere else.
 */
test('a soft-deleted agent is filtered out of every agent read', () => {
  for (const scope of [
    { organizationId, userId },
    { organizationId, userId, includeUnbound: true },
  ]) {
    assert.equal(
      (buildVisibleAgentWhere(scope) as { deletedAt?: unknown }).deletedAt,
      null,
      JSON.stringify(scope),
    )
  }
})
