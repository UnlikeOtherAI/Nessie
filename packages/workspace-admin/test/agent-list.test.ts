import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { buildAgentVisibilityWhere, buildVisibleAgentWhere } from '@nessie/db'

import { listAgentsForUser } from '../src/agent-list.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'

const listWhere = async (includeUnbound: boolean, includeSystemManaged: boolean) => {
  const calls: Array<{ where: unknown }> = []
  const prisma = {
    agent: {
      findMany: async (input: { where: unknown }) => {
        calls.push(input)
        return []
      },
    },
  } as unknown as PrismaClient

  await listAgentsForUser(prisma, userId, organizationId, includeUnbound, includeSystemManaged)
  return calls[0]?.where
}

test('the ordinary agent list keeps the shared non-system visibility fragment intact', async () => {
  assert.deepEqual(await listWhere(false, false), {
    AND: [buildAgentVisibilityWhere({ organizationId, userId })],
    organizationId,
    OR: [buildVisibleAgentWhere({ organizationId, userId })],
  })
})

test('scope=all adds the channel-reachable system tier without widening the ordinary tier', async () => {
  assert.deepEqual(await listWhere(false, true), {
    AND: [buildAgentVisibilityWhere({ organizationId, userId })],
    organizationId,
    OR: [
      buildVisibleAgentWhere({ organizationId, userId }),
      {
        organizationId,
        systemManaged: true,
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
    ],
  })
})
