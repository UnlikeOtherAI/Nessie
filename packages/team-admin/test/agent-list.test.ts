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

test('scope=all adds the whole system tier without widening the ordinary tier', async () => {
  // Deliberately NOT channel-gated: a global agent is app-provided, holds no
  // tenant secrets, and its per-user home DM does not exist until that person's
  // next login — so gating the tier on a binding made the Agent Designer
  // invisible to everyone, the unreachable-capability defect. The ordinary
  // (non-system) arm is untouched, and per-agent reads still 404 on these rows.
  assert.deepEqual(await listWhere(false, true), {
    AND: [buildAgentVisibilityWhere({ organizationId, userId })],
    organizationId,
    OR: [
      buildVisibleAgentWhere({ organizationId, userId }),
      { organizationId, systemManaged: true },
    ],
  })
})
