import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import {
  createCatalogEntry,
  createInstance,
  findApplicableLock,
  MCP_CATALOG_ERROR_CODES,
  MCP_INSTANCE_ERROR_CODES,
  McpCatalogError,
  McpInstanceError,
  setCatalogEntryLocked,
  type McpCatalogEntryRow,
} from '../src/index.js'

/**
 * Admin locking: members cannot install a locked connector, nor re-register
 * its endpoint under a fresh name; owners/admins are exempt and are the only
 * roles that can toggle the lock.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const MEMBER = '00000000-0000-4000-8000-0000000000c1'
const ADMIN = '00000000-0000-4000-8000-0000000000c2'

const actor = (userId: string, roles: string[]): AuthorizedActionContext =>
  ({
    tenant: { organizationId: ORG },
    actor: { actorId: userId, actorType: 'user', roles },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

const lockedEntry = {
  id: 'entry-1',
  organizationId: ORG,
  name: 'stripe',
  label: 'Stripe',
  description: '',
  protocol: 'http',
  authMethod: 'none',
  authConfig: { method: 'none' },
  defaultTransportConfig: { transport: 'http', url: 'https://mcp.stripe.com' },
  status: 'published',
  visibility: 'public',
  locked: true,
  lockedAt: new Date(),
  lockedBy: ADMIN,
  ownerUserId: null,
} as unknown as McpCatalogEntryRow

type MemberRoleByUser = Record<string, 'owner' | 'admin' | 'member'>

const makePrisma = (options: {
  entry?: McpCatalogEntryRow
  lockedEntries?: McpCatalogEntryRow[]
  roles?: MemberRoleByUser
}): { prisma: PrismaClient; created: Record<string, unknown>[] } => {
  const created: Record<string, unknown>[] = []
  const roles: MemberRoleByUser = options.roles ?? { [MEMBER]: 'member', [ADMIN]: 'admin' }
  const prisma = {
    mcpCatalogEntry: {
      findFirst: async () => options.entry ?? lockedEntry,
      findMany: async () => options.lockedEntries ?? [lockedEntry],
      update: async (args: { data: Record<string, unknown> }) => ({
        ...(options.entry ?? lockedEntry),
        ...args.data,
      }),
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return { id: 'new-entry', ...args.data }
      },
    },
    organizationMember: {
      findUnique: async ({ where }: { where: { organizationId_userId: { userId: string } } }) => {
        const role = roles[where.organizationId_userId.userId]
        return role ? { role, deactivatedAt: null, id: 'm1' } : null
      },
    },
    mcpServerInstance: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return { id: 'new-instance', ...args.data }
      },
    },
  } as unknown as PrismaClient
  return { prisma, created }
}

test('setCatalogEntryLocked rejects non-admin actors', async () => {
  const { prisma } = makePrisma({})
  await assert.rejects(
    setCatalogEntryLocked(prisma, actor(MEMBER, []), 'entry-1', true),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.FORBIDDEN,
  )
})

test('setCatalogEntryLocked allows org admins and stamps lock metadata', async () => {
  const { prisma } = makePrisma({})
  const unlocked = { ...lockedEntry, locked: false, lockedAt: null, lockedBy: null }
  const { prisma: prisma2 } = makePrisma({ entry: unlocked as McpCatalogEntryRow })
  const result = await setCatalogEntryLocked(prisma2, actor(ADMIN, ['admin']), 'entry-1', true)
  assert.equal(result?.locked, true)
  assert.equal(result?.lockedBy, ADMIN)
  // Idempotent when already in the requested state.
  const already = await setCatalogEntryLocked(prisma, actor(ADMIN, ['admin']), 'entry-1', true)
  assert.equal(already?.locked, true)
})

test('createInstance refuses a member installing a locked connector', async () => {
  const { prisma } = makePrisma({})
  await assert.rejects(
    createInstance(prisma, actor(MEMBER, []), {
      catalogEntryId: 'entry-1',
      scopeType: 'user',
      scopeId: MEMBER,
    }),
    (error: unknown) =>
      error instanceof McpInstanceError
      && error.code === MCP_INSTANCE_ERROR_CODES.LOCKED,
  )
})

test('createInstance lets owners/admins install a locked connector', async () => {
  const { prisma, created } = makePrisma({})
  const instance = await createInstance(prisma, actor(ADMIN, ['admin']), {
    catalogEntryId: 'entry-1',
    scopeType: 'organization',
    scopeId: ORG,
  })
  assert.equal(instance.id, 'new-instance')
  assert.equal(created.length, 1)
})

test('createInstance reserves first-party DeepWater for managed provisioning', async () => {
  const deepWaterEntry = {
    ...lockedEntry,
    id: 'deep-water-entry',
    name: 'deep-water',
    label: 'Deep Water',
    locked: false,
    defaultTransportConfig: {
      transport: 'http',
      url: 'https://ledger.unlikeotherai.com/v1/mcp/deepwater',
    },
    integratedProducts: [{ slug: 'deep-water' }],
  } as unknown as McpCatalogEntryRow
  const { prisma, created } = makePrisma({
    entry: deepWaterEntry,
    lockedEntries: [],
  })

  await assert.rejects(
    createInstance(prisma, actor(MEMBER, []), {
      catalogEntryId: deepWaterEntry.id,
      scopeType: 'user',
      scopeId: MEMBER,
    }),
    (error: unknown) =>
      error instanceof McpInstanceError
      && error.code === MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION,
  )
  const provisioned = await createInstance(prisma, actor(MEMBER, []), {
    catalogEntryId: deepWaterEntry.id,
    scopeType: 'user',
    scopeId: MEMBER,
    managedProvision: true,
  })
  assert.equal(provisioned.id, 'new-instance')
  assert.equal(created.length, 1)
})

test('findApplicableLock matches the same endpoint registered under another entry', async () => {
  const { prisma } = makePrisma({})
  const lock = await findApplicableLock(
    prisma,
    ORG,
    null,
    'https://mcp.stripe.com/',
  )
  assert.equal(lock?.label, 'Stripe')
  assert.equal(await findApplicableLock(prisma, ORG, null, 'https://other.example/mcp'), null)
})

test('createCatalogEntry blocks members re-registering a locked endpoint', async () => {
  const { prisma } = makePrisma({})
  await assert.rejects(
    createCatalogEntry(prisma, actor(MEMBER, []), {
      name: 'stripe-again',
      label: 'Stripe again',
      protocol: 'http',
      authMethod: 'none',
      authConfig: { method: 'none' },
      defaultTransportConfig: { transport: 'http', url: 'https://mcp.stripe.com' },
    }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.LOCKED,
  )
})

test('createCatalogEntry lets admins register a locked endpoint', async () => {
  const { prisma, created } = makePrisma({})
  const entry = await createCatalogEntry(prisma, actor(ADMIN, ['admin']), {
    name: 'stripe-admin',
    label: 'Stripe (admin)',
    protocol: 'http',
    authMethod: 'none',
    authConfig: { method: 'none' },
    defaultTransportConfig: { transport: 'http', url: 'https://mcp.stripe.com' },
  })
  assert.equal(entry.id, 'new-entry')
  assert.equal(created.length, 1)
})
