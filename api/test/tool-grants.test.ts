import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  createGrant,
  deleteGrant,
  listToolRegistry,
  TOOL_GRANT_ERROR_CODES,
  ToolGrantError,
} from '../src/services/tool-grants.js'

/**
 * Regression coverage for the cross-org authorization bypass closed in #19.
 *
 * The bug: `createGrant` / `deleteGrant` resolved the tool registry entry by id
 * only, so an owner in org A could pass org B's tool id and either create a
 * grant on (or delete a grant from) a tool they did not own. The fix routes
 * the lookup through the same `OR: [{ organizationId: null }, { organizationId }]`
 * scoping used by `listToolRegistry`, which preserves access to global registry
 * entries (`organizationId: null`) while blocking cross-org access.
 */

type ToolEntryFixture = {
  id: string
  organizationId: string | null
}

type GrantFixture = {
  id: string
  toolId: string
}

type FakePrisma = {
  prisma: PrismaClient
  registry: ToolEntryFixture[]
  grants: GrantFixture[]
  deletedGrantIds: string[]
}

const buildFakePrisma = (
  registry: ToolEntryFixture[],
  grants: GrantFixture[] = [],
): FakePrisma => {
  const deletedGrantIds: string[] = []

  const matchesRegistryWhere = (entry: ToolEntryFixture, where: any): boolean => {
    if (where.id && entry.id !== where.id) return false
    if (where.OR) {
      const matched = (where.OR as Array<{ organizationId: string | null }>).some(
        (clause) => entry.organizationId === clause.organizationId,
      )
      if (!matched) return false
    }
    return true
  }

  const prisma = {
    toolRegistryEntry: {
      findFirst: async ({ where }: { where: any }) =>
        registry.find((entry) => matchesRegistryWhere(entry, where)) ?? null,
    },
    toolGrant: {
      create: async ({ data }: { data: any }) => ({
        id: `grant-${grants.length + 1}`,
        toolId: data.toolId,
        state: data.state ?? 'allowed',
        config: data.config ?? {},
        source: data.source,
        roleId: data.roleId ?? null,
        agentId: data.agentId ?? null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      findFirst: async ({ where }: { where: any }) =>
        grants.find(
          (grant) => grant.id === where.id && grant.toolId === where.toolId,
        ) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        deletedGrantIds.push(where.id)
        return { id: where.id }
      },
    },
  }

  return {
    prisma: prisma as unknown as PrismaClient,
    registry,
    grants,
    deletedGrantIds,
  }
}

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'
const ROLE_A = '00000000-0000-4000-8000-0000000000aa'

const makeListedTool = (input: {
  catalogName: string
  catalogOrganizationId?: string | null
  catalogVisibility?: 'private' | 'public'
  id: string
  productSlugs: string[]
}) => ({
  builtin: false,
  bundleId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: 'system',
  description: 'Projected research tool',
  enabled: true,
  handlerKind: 'mcp',
  id: input.id,
  inputSchema: {},
  label: input.id,
  mcpInstance: {
    catalogEntry: {
      integratedProducts: input.productSlugs.map((slug) => ({ slug })),
      name: input.catalogName,
      organizationId: input.catalogOrganizationId ?? null,
      visibility: input.catalogVisibility ?? 'public',
    },
  },
  mcpInstanceId: `instance-${input.id}`,
  metadata: { requiresExplicitGrant: true },
  organizationId: ORG_A,
  outputSchema: null,
  scopeKey: `org/${ORG_A}`,
  source: 'mcp_remote',
  status: 'active',
  tags: [],
  toolId: `mcp:deep-water:${input.id}`,
  transport: 'mcp',
  transportConfig: {},
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  version: '1.0.0',
})

test('listToolRegistry derives managed product identity by exact catalog membership', async () => {
  let catalogSelect: Record<string, unknown> | undefined
  const prisma = {
    toolRegistryEntry: {
      findMany: async (args: {
        include: {
          mcpInstance: {
            select: {
              catalogEntry: { select: Record<string, unknown> }
            }
          }
        }
      }) => {
        catalogSelect = args.include.mcpInstance.select.catalogEntry.select
        return [
          makeListedTool({
            catalogName: 'deep-water',
            id: 'exact-match',
            productSlugs: ['another-product', 'deep-water'],
          }),
          makeListedTool({
            catalogName: 'deep-water',
            id: 'missing-membership',
            productSlugs: ['another-product'],
          }),
          makeListedTool({
            catalogName: 'deep-water',
            catalogVisibility: 'private',
            id: 'private-catalog',
            productSlugs: ['deep-water'],
          }),
        ]
      },
    },
  } as unknown as PrismaClient

  const tools = await listToolRegistry(prisma, ORG_A)

  assert.equal(catalogSelect?.name, true)
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.managedProductSlug]),
    [
      ['exact-match', 'deep-water'],
      ['missing-membership', null],
      ['private-catalog', null],
    ],
  )
})

test('createGrant rejects when the tool belongs to a different org', async () => {
  const { prisma } = buildFakePrisma([
    { id: 'tool-orgB', organizationId: ORG_B },
  ])

  let thrown: unknown
  try {
    await createGrant(prisma, {
      toolRegistryEntryId: 'tool-orgB',
      organizationId: ORG_A,
      roleId: ROLE_A,
    })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ToolGrantError)
  assert.equal(
    (thrown as ToolGrantError).code,
    TOOL_GRANT_ERROR_CODES.TOOL_NOT_FOUND,
  )
})

test('createGrant succeeds when the tool belongs to the caller org', async () => {
  const { prisma } = buildFakePrisma([
    { id: 'tool-orgA', organizationId: ORG_A },
  ])

  const grant = await createGrant(prisma, {
    toolRegistryEntryId: 'tool-orgA',
    organizationId: ORG_A,
    roleId: ROLE_A,
  })

  assert.equal(grant.toolId, 'tool-orgA')
  assert.equal(grant.roleId, ROLE_A)
})

test('createGrant succeeds for global (organizationId=null) registry entries', async () => {
  const { prisma } = buildFakePrisma([
    { id: 'tool-global', organizationId: null },
  ])

  const grant = await createGrant(prisma, {
    toolRegistryEntryId: 'tool-global',
    organizationId: ORG_A,
    roleId: ROLE_A,
  })

  assert.equal(grant.toolId, 'tool-global')
})

test('deleteGrant refuses to delete a grant whose tool belongs to another org', async () => {
  const fake = buildFakePrisma(
    [{ id: 'tool-orgB', organizationId: ORG_B }],
    [{ id: 'grant-orgB', toolId: 'tool-orgB' }],
  )

  const result = await deleteGrant(fake.prisma, ORG_A, 'tool-orgB', 'grant-orgB')

  assert.equal(result, false)
  assert.deepEqual(fake.deletedGrantIds, [])
})

test('deleteGrant removes the grant when the tool belongs to the caller org', async () => {
  const fake = buildFakePrisma(
    [{ id: 'tool-orgA', organizationId: ORG_A }],
    [{ id: 'grant-orgA', toolId: 'tool-orgA' }],
  )

  const result = await deleteGrant(fake.prisma, ORG_A, 'tool-orgA', 'grant-orgA')

  assert.equal(result, true)
  assert.deepEqual(fake.deletedGrantIds, ['grant-orgA'])
})

test('deleteGrant accepts global registry entries from any org', async () => {
  const fake = buildFakePrisma(
    [{ id: 'tool-global', organizationId: null }],
    [{ id: 'grant-1', toolId: 'tool-global' }],
  )

  const result = await deleteGrant(fake.prisma, ORG_A, 'tool-global', 'grant-1')

  assert.equal(result, true)
  assert.deepEqual(fake.deletedGrantIds, ['grant-1'])
})
