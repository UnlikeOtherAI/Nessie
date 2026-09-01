import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  approveSubmission,
  deleteCatalogEntry,
  deprecateCatalogEntry,
  McpInstanceError,
  MCP_INSTANCE_ERROR_CODES,
  publishCatalogEntry,
  rejectSubmission,
  setCatalogEntryLocked,
  submitForReview,
  updateCatalogEntry,
} from '../src/index.js'

const ENTRY_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
const OWNER_ID = '33333333-3333-4333-8333-333333333333'

const actorContext = {
  actor: { actorId: OWNER_ID, actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'managed-catalog-test' },
  tenant: { organizationId: ORGANIZATION_ID },
} as AuthorizedActionContext

const managedEntry = {
  id: ENTRY_ID,
  organizationId: null,
  name: 'deepsignal',
  label: 'DeepSignal',
  description: '',
  protocol: 'http',
  authMethod: 'bearer',
  authConfig: { method: 'bearer' },
  defaultTransportConfig: {
    transport: 'http',
    url: 'https://api.deepsignal.live/mcp',
  },
  iconUrl: null,
  vendor: 'UnlikeOtherAI',
  sourceUrl: null,
  signature: null,
  status: 'pending_approval',
  visibility: 'public',
  locked: false,
  lockedAt: null,
  lockedBy: null,
  ownerUserId: null,
  submittedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  rejectionReason: null,
  createdBy: OWNER_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
} as const

const managedError = (error: unknown): boolean =>
  error instanceof McpInstanceError
  && error.code === MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION

test('managed DeepSignal rejects every generic catalog mutation before write', async () => {
  const mutations = { delete: 0, update: 0, updateMany: 0 }
  const prisma = {
    // The actor is otherwise fully authorized — instance super-admin on an
    // instance-global row — so the only thing that can refuse here is the
    // managed-integration fence this test is about.
    user: { findUnique: async () => ({ superAdmin: true }) },
    mcpCatalogEntry: {
      findFirst: async (args: { select?: unknown }) =>
        args.select
          ? {
              integratedProducts: [{ slug: 'deepsignal' }],
              name: 'deepsignal',
              organizationId: null,
              visibility: 'public',
            }
          : managedEntry,
      delete: async () => {
        mutations.delete += 1
        return {}
      },
      update: async () => {
        mutations.update += 1
        return managedEntry
      },
      updateMany: async () => {
        mutations.updateMany += 1
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient

  const operations = [
    () => updateCatalogEntry(prisma, actorContext, ENTRY_ID, { label: 'Changed' }),
    () => deleteCatalogEntry(prisma, actorContext, ENTRY_ID),
    () => publishCatalogEntry(prisma, actorContext, ENTRY_ID),
    () => deprecateCatalogEntry(prisma, actorContext, ENTRY_ID),
    () => setCatalogEntryLocked(prisma, actorContext, ENTRY_ID, true),
    () => submitForReview(prisma, actorContext, ENTRY_ID),
    () => approveSubmission(prisma, actorContext, ENTRY_ID),
    () => rejectSubmission(prisma, actorContext, ENTRY_ID, 'no'),
  ]

  for (const operation of operations) {
    await assert.rejects(operation(), managedError)
  }
  assert.deepEqual(mutations, { delete: 0, update: 0, updateMany: 0 })
})
