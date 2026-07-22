import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  BootstrapAlreadyInitializedError,
  seedBootstrapRecords,
} from '../src/db/seed.js'

test('bootstrap locks globally and rechecks durable state before seeding', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRaw: async () => {
      calls.push('lock')
      return [{ acquired: 1 }]
    },
    organization: {
      count: async () => {
        calls.push('organization-count')
        return 1
      },
    },
    user: {
      count: async () => {
        calls.push('user-count')
        return 0
      },
    },
  }
  const prisma = {
    $transaction: async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
  } as unknown as PrismaClient

  await assert.rejects(
    seedBootstrapRecords(prisma, {
      displayName: 'Late bootstrap',
      email: 'late@example.com',
    }),
    BootstrapAlreadyInitializedError,
  )

  assert.equal(calls[0], 'lock')
  assert.deepEqual(new Set(calls.slice(1)), new Set(['organization-count', 'user-count']))
})
