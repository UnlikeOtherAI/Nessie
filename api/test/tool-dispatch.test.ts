import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  planToolDispatch,
  TOOL_DISPATCH_ERROR_CODES,
  ToolDispatchError,
} from '../src/services/tool-dispatch.js'

/**
 * Regression coverage for the cross-org dispatch bypass closed in #19.
 *
 * `planToolDispatch` now resolves the registry entry with the same OR clause
 * used by createGrant/deleteGrant — global entries (`organizationId: null`)
 * remain dispatchable from every org, but org-owned entries can only be
 * dispatched by callers in the owning org.
 */

type ToolEntryFixture = {
  id: string
  organizationId: string | null
  enabled: boolean
  status: string
  transport: string
  transportConfig: unknown
  mcpInstanceId: string | null
}

const buildPrisma = (registry: ToolEntryFixture[]): PrismaClient => {
  const matchesWhere = (entry: ToolEntryFixture, where: any): boolean => {
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
        registry.find((entry) => matchesWhere(entry, where)) ?? null,
    },
    toolGrant: {
      findMany: async () => [],
    },
  }

  return prisma as unknown as PrismaClient
}

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

test('planToolDispatch rejects when the tool belongs to a different org', async () => {
  const prisma = buildPrisma([
    {
      id: 'tool-orgB',
      organizationId: ORG_B,
      enabled: true,
      status: 'active',
      transport: 'http',
      transportConfig: { transport: 'http', url: 'https://example/api' },
      mcpInstanceId: null,
    },
  ])

  let thrown: unknown
  try {
    await planToolDispatch(prisma, 'tool-orgB', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: {},
    })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.TOOL_NOT_FOUND,
  )
})

test('planToolDispatch passes registry lookup for global tools regardless of caller org', async () => {
  // Use an HTTP tool with no instance / no grant: this lets us assert that the
  // registry-lookup pass is what changed — we expect the call to advance past
  // the cross-org check and fail later on the grant check.
  const prisma = buildPrisma([
    {
      id: 'tool-global',
      organizationId: null,
      enabled: true,
      status: 'active',
      transport: 'http',
      transportConfig: { transport: 'http', url: 'https://example/api' },
      mcpInstanceId: null,
    },
  ])

  let thrown: unknown
  try {
    await planToolDispatch(prisma, 'tool-global', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: {},
    })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.GRANT_DENIED,
  )
})

test('planToolDispatch passes registry lookup when caller org matches', async () => {
  const prisma = buildPrisma([
    {
      id: 'tool-orgA',
      organizationId: ORG_A,
      enabled: true,
      status: 'active',
      transport: 'http',
      transportConfig: { transport: 'http', url: 'https://example/api' },
      mcpInstanceId: null,
    },
  ])

  let thrown: unknown
  try {
    await planToolDispatch(prisma, 'tool-orgA', {
      organizationId: ORG_A,
      principals: { roleIds: ['role-1'] },
      credentialContext: {},
    })
  } catch (error) {
    thrown = error
  }

  // Same advance-past-cross-org-check assertion: caller now hits the grant
  // gate, not the tool-not-found gate.
  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.GRANT_DENIED,
  )
})
