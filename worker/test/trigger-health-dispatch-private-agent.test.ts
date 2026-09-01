import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { handleTriggerHealthAlert } from '../src/control/trigger-health-dispatch.js'

const organizationId = '10000000-0000-4000-8000-000000000001'
const triggerId = '10000000-0000-4000-8000-000000000002'
const privateOwnerId = '10000000-0000-4000-8000-000000000003'
const orgOwnerId = '10000000-0000-4000-8000-000000000004'

test('a private agent health alert reaches its active owner alone', async () => {
  const alertRows: Array<{ userId: string }> = []
  let ownerListRead = false
  const prisma = {
    agentTrigger: {
      findUnique: async () => ({
        agent: {
          organizationId,
          ownerUserId: privateOwnerId,
          visibility: 'private' as const,
        },
        config: { launchOrigin: { userId: privateOwnerId } },
        name: 'Private daily brief',
        targetChannel: null,
        workflowInstallation: null,
      }),
    },
    organizationMember: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        where.userId === privateOwnerId ? { userId: privateOwnerId } : null,
      findMany: async () => {
        ownerListRead = true
        return [{ userId: orgOwnerId }]
      },
    },
    userAlert: {
      createMany: async ({ data }: { data: Array<{ userId: string }> }) => {
        alertRows.push(...data)
        return { count: data.length }
      },
    },
    pushCredential: { findMany: async () => [] },
    mcpOAuthSecret: { findUnique: async () => null },
  } as unknown as PrismaClient

  await handleTriggerHealthAlert(
    { authSecret: 'test-secret', prisma },
    {
      healthRevision: 1,
      reason: 'uoa_identity_unverifiable',
      status: 'needs_reauthorization',
      triggerId,
    },
  )

  assert.deepEqual(alertRows.map((row) => row.userId), [privateOwnerId])
  assert.equal(ownerListRead, false, 'private alerts must not widen to organization owners')
})
