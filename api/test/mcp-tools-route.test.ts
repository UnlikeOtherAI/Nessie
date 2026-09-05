import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { attachGrantsToRegistryEntries } from '../src/routes/mcp.js'
import type { ToolRegistryRow } from '../src/services/tool-grants.js'

/**
 * Coverage for task #25: `GET /api/mcp/tools` includes per-entry `grants`
 * so the admin `AgentGrantMatrix` can render pre-existing grants on initial
 * load (no need to capture grant ids from in-session POSTs).
 *
 * We exercise the route's grant-attach helper directly. Routing/auth gates
 * are unchanged and already covered by upstream tests; the new contract is
 * the shape of each registry entry.
 */

type GrantFixture = {
  id: string
  toolId: string
  state: string
  config: unknown
  source: string
  roleId: string | null
  agentId: string | null
  createdAt: Date
  updatedAt: Date
}

type FindManyArgs = {
  where?: { toolId?: { in?: string[] } }
  orderBy?: unknown
}

const makeRegistryEntry = (overrides: Partial<ToolRegistryRow>): ToolRegistryRow => ({
  id: overrides.id ?? 'tool-1',
  organizationId: overrides.organizationId ?? 'org-A',
  scopeKey: overrides.scopeKey ?? 'org/org-A',
  toolId: overrides.toolId ?? 'http_fetch',
  label: overrides.label ?? 'HTTP Fetch',
  description: overrides.description ?? '',
  source: overrides.source ?? 'builtin',
  transport: overrides.transport ?? 'direct',
  transportConfig: overrides.transportConfig ?? {},
  bundleId: overrides.bundleId ?? null,
  mcpInstanceId: overrides.mcpInstanceId ?? null,
  inputSchema: overrides.inputSchema ?? {},
  outputSchema: overrides.outputSchema ?? null,
  tags: overrides.tags ?? [],
  status: overrides.status ?? 'active',
  version: overrides.version ?? '1.0.0',
  createdBy: overrides.createdBy ?? 'system',
  enabled: overrides.enabled ?? true,
  builtin: overrides.builtin ?? true,
  managedProductSlug: overrides.managedProductSlug ?? null,
  policyKey: overrides.policyKey ?? overrides.toolId ?? 'http_fetch',
  requiresExplicitGrant: overrides.requiresExplicitGrant ?? false,
  createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
})

const makeGrant = (overrides: Partial<GrantFixture> & { id: string; toolId: string }): GrantFixture => ({
  state: 'allowed',
  config: {},
  source: 'agent_override',
  roleId: null,
  agentId: null,
  createdAt: new Date('2026-01-02T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  ...overrides,
})

type FakeState = {
  prisma: PrismaClient
  findManyCalls: FindManyArgs[]
}

const buildFakePrisma = (grants: GrantFixture[]): FakeState => {
  const findManyCalls: FindManyArgs[] = []
  const prisma = {
    toolGrant: {
      findMany: async (args: FindManyArgs) => {
        findManyCalls.push(args)
        const ids = args.where?.toolId?.in ?? []
        return grants.filter((grant) => ids.includes(grant.toolId))
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, findManyCalls }
}

// The caller's tenant. The fake below ignores the tenancy clause, which is
// exactly why `mcp-tool-grants-tenancy-db.test.ts` runs the same read against
// Postgres — these cases cover shape and mapping, not scoping.
const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000f1'

test('attachGrantsToRegistryEntries returns an empty array when no entries are supplied', async () => {
  const { prisma, findManyCalls } = buildFakePrisma([])
  const result = await attachGrantsToRegistryEntries(prisma, ORGANIZATION_ID, [])
  assert.deepEqual(result, [])
  // No DB roundtrip on the empty path — avoids a needless Postgres call when
  // the registry list itself is empty (zero-tool orgs).
  assert.equal(findManyCalls.length, 0)
})

test('attachGrantsToRegistryEntries returns each entry with its own grants', async () => {
  const entries = [
    makeRegistryEntry({ id: 'tool-1', label: 'Tool One' }),
    makeRegistryEntry({ id: 'tool-2', label: 'Tool Two' }),
  ]
  const { prisma, findManyCalls } = buildFakePrisma([
    makeGrant({ id: 'grant-1', toolId: 'tool-1', agentId: 'agent-A' }),
    makeGrant({ id: 'grant-2', toolId: 'tool-1', agentId: 'agent-B' }),
    makeGrant({ id: 'grant-3', toolId: 'tool-2', roleId: 'role-X', source: 'role' }),
  ])

  const result = await attachGrantsToRegistryEntries(prisma, ORGANIZATION_ID, entries)

  assert.equal(result.length, 2)
  assert.equal(result[0]!.id, 'tool-1')
  assert.equal(result[0]!.grants.length, 2)
  assert.deepEqual(
    result[0]!.grants.map((grant) => grant.id),
    ['grant-1', 'grant-2'],
  )
  assert.equal(result[1]!.id, 'tool-2')
  assert.equal(result[1]!.grants.length, 1)
  assert.equal(result[1]!.grants[0]!.id, 'grant-3')
  // One findMany call carrying every tool id — no N+1.
  assert.equal(findManyCalls.length, 1)
  assert.deepEqual(findManyCalls[0]!.where?.toolId?.in, ['tool-1', 'tool-2'])
})

test('attachGrantsToRegistryEntries leaves grants empty for tools with no grants', async () => {
  const entries = [
    makeRegistryEntry({ id: 'tool-with-grant' }),
    makeRegistryEntry({ id: 'tool-without-grant' }),
  ]
  const { prisma } = buildFakePrisma([
    makeGrant({ id: 'grant-1', toolId: 'tool-with-grant', agentId: 'agent-A' }),
  ])

  const result = await attachGrantsToRegistryEntries(prisma, ORGANIZATION_ID, entries)

  const grantedEntry = result.find((entry) => entry.id === 'tool-with-grant')
  const ungrantedEntry = result.find((entry) => entry.id === 'tool-without-grant')
  assert.ok(grantedEntry)
  assert.ok(ungrantedEntry)
  assert.equal(grantedEntry.grants.length, 1)
  assert.deepEqual(ungrantedEntry.grants, [])
})

test('attachGrantsToRegistryEntries maps prisma grant-source enum to wire form', async () => {
  const entries = [makeRegistryEntry({ id: 'tool-1' })]
  const { prisma } = buildFakePrisma([
    makeGrant({ id: 'grant-role', toolId: 'tool-1', roleId: 'role-X', source: 'role' }),
    makeGrant({
      id: 'grant-agent',
      toolId: 'tool-1',
      agentId: 'agent-A',
      source: 'agent_override',
    }),
  ])

  const result = await attachGrantsToRegistryEntries(prisma, ORGANIZATION_ID, entries)

  const grants = result[0]!.grants
  const roleGrant = grants.find((grant) => grant.id === 'grant-role')
  const agentGrant = grants.find((grant) => grant.id === 'grant-agent')
  assert.ok(roleGrant)
  assert.ok(agentGrant)
  // Wire-side enum is `agent-override` (kebab); Prisma stores `agent_override`.
  assert.equal(roleGrant.source, 'role')
  assert.equal(agentGrant.source, 'agent-override')
})
