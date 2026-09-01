import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  deleteInstance,
  healthcheckInstance,
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
  refreshInstance,
  testInstance,
} from '../src/index.js'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const CATALOG_ID = '22222222-2222-4222-8222-222222222222'
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333'

const managedCatalog = (slug: 'deep-water' | 'deepsignal') => ({
  integratedProducts: [{ slug }],
  name: slug,
  organizationId: null,
  visibility: 'public',
})

const createPrisma = (
  managedSlug: 'deep-water' | 'deepsignal' | null = 'deep-water',
) => {
  const mutations = {
    delete: 0,
    transaction: 0,
    update: 0,
  }
  const prisma = {
    mcpCatalogEntry: {
      findFirst: async () =>
        managedSlug ? managedCatalog(managedSlug) : null,
    },
    mcpServerInstance: {
      delete: async () => {
        mutations.delete += 1
        return {}
      },
      findFirst: async () => ({
        catalogEntryId: CATALOG_ID,
        id: INSTANCE_ID,
        organizationId: ORGANIZATION_ID,
      }),
      update: async () => {
        mutations.update += 1
        return {}
      },
    },
    $transaction: async () => {
      mutations.transaction += 1
      return {}
    },
  } as unknown as PrismaClient
  return { mutations, prisma }
}

const isManagedError = (error: unknown): boolean =>
  error instanceof McpInstanceError
  && error.code === MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION

test('managed DeepWater rejects every generic lifecycle operation before mutation', async () => {
  const operations = [
    (prisma: PrismaClient) =>
      testInstance(prisma, ORGANIZATION_ID, INSTANCE_ID, { probeUserId: 'probe-user-1' }),
    (prisma: PrismaClient) =>
      refreshInstance(prisma, ORGANIZATION_ID, INSTANCE_ID, { probeUserId: 'probe-user-1' }),
    (prisma: PrismaClient) =>
      healthcheckInstance(prisma, ORGANIZATION_ID, INSTANCE_ID, { probeUserId: 'probe-user-1' }),
    (prisma: PrismaClient) =>
      deleteInstance(prisma, ORGANIZATION_ID, INSTANCE_ID),
  ]

  for (const operation of operations) {
    const { mutations, prisma } = createPrisma()
    await assert.rejects(operation(prisma), isManagedError)
    assert.deepEqual(mutations, {
      delete: 0,
      transaction: 0,
      update: 0,
    })
  }
})

test('managed DeepSignal rejects every generic lifecycle operation before mutation', async () => {
  const operations = [
    (prisma: PrismaClient) =>
      testInstance(prisma, ORGANIZATION_ID, INSTANCE_ID, { probeUserId: 'probe-user-1' }),
    (prisma: PrismaClient) =>
      refreshInstance(prisma, ORGANIZATION_ID, INSTANCE_ID, { probeUserId: 'probe-user-1' }),
    (prisma: PrismaClient) =>
      healthcheckInstance(prisma, ORGANIZATION_ID, INSTANCE_ID, { probeUserId: 'probe-user-1' }),
    (prisma: PrismaClient) =>
      deleteInstance(prisma, ORGANIZATION_ID, INSTANCE_ID),
  ]

  for (const operation of operations) {
    const { mutations, prisma } = createPrisma('deepsignal')
    await assert.rejects(operation(prisma), isManagedError)
    assert.deepEqual(mutations, {
      delete: 0,
      transaction: 0,
      update: 0,
    })
  }
})

test('a private same-name connector remains user-managed', async () => {
  const { mutations, prisma } = createPrisma(null)

  assert.equal(
    await deleteInstance(prisma, ORGANIZATION_ID, INSTANCE_ID),
    true,
  )
  assert.equal(mutations.delete, 1)
})
