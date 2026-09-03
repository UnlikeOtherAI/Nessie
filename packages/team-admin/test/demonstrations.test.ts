import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { getDemonstrationForUser } from '../src/demonstrations.js'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const USER_ID = '10000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '10000000-0000-4000-8000-000000000003'
const THREAD_ID = '10000000-0000-4000-8000-000000000004'
const AGENT_ID = '10000000-0000-4000-8000-000000000005'
const DEMONSTRATION_ID = '10000000-0000-4000-8000-000000000006'

const demonstration = {
  agentId: AGENT_ID,
  capturedAt: null,
  channelId: CHANNEL_ID,
  expiresAt: new Date('2026-08-31T13:00:00.000Z'),
  id: DEMONSTRATION_ID,
  organizationId: ORGANIZATION_ID,
  startedAt: new Date('2026-08-31T09:00:00.000Z'),
  startedByUserId: USER_ID,
  status: 'captured' as const,
  stepCount: 1,
  threadId: THREAD_ID,
  steps: [{
    agentId: AGENT_ID,
    argumentsJson: { password: '[REDACTED]', query: 'release notes' },
    demonstrationId: DEMONSTRATION_ID,
    durationMs: 50,
    endedAt: new Date('2026-08-31T09:00:01.000Z'),
    id: '10000000-0000-4000-8000-000000000007',
    runId: '10000000-0000-4000-8000-000000000008',
    sequence: 1,
    startedAt: new Date('2026-08-31T09:00:00.000Z'),
    success: true,
    toolName: 'web_search',
  }],
}

const createPrisma = (channelReachable: boolean) => {
  const whereCalls: unknown[] = []
  const prisma = {
    channel: {
      findUnique: async () => ({
        members: channelReachable ? [{ id: 'member' }] : [],
        organizationId: ORGANIZATION_ID,
        systemChannelType: null,
        type: 'standard',
        visibility: 'private',
      }),
    },
    demonstration: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async (input: { where: unknown }) => {
        whereCalls.push(input.where)
        return demonstration
      },
    },
  } as unknown as PrismaClient
  return { prisma, whereCalls }
}

test('demonstration draft reads use the owner and organization predicate and return ordered redacted steps', async () => {
  const { prisma, whereCalls } = createPrisma(true)

  const result = await getDemonstrationForUser(prisma, {
    demonstrationId: DEMONSTRATION_ID,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
  })

  assert.equal(result?.id, DEMONSTRATION_ID)
  assert.deepEqual(result?.steps[0]?.argumentsJson, {
    password: '[REDACTED]',
    query: 'release notes',
  })
  assert.deepEqual(whereCalls[0], {
    id: DEMONSTRATION_ID,
    organizationId: ORGANIZATION_ID,
    startedByUserId: USER_ID,
  })
})

test('demonstration draft reads fail closed when the owner cannot reach its channel', async () => {
  const { prisma } = createPrisma(false)

  const result = await getDemonstrationForUser(prisma, {
    demonstrationId: DEMONSTRATION_ID,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
  })

  assert.equal(result, null)
})
