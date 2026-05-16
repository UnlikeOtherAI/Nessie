import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
  deprecateCatalogEntry,
  ensureAuthConfigMatchesMethod,
  publishCatalogEntry,
  type McpCatalogEntryRow,
} from '../src/services/mcp-catalog.js'

test('ensureAuthConfigMatchesMethod returns parsed config when method matches', () => {
  const result = ensureAuthConfigMatchesMethod('api_key', {
    method: 'api_key',
    headerName: 'X-API-Key',
    valuePrefix: '',
  })
  assert.equal(result.method, 'api_key')
  if (result.method === 'api_key') {
    assert.equal(result.headerName, 'X-API-Key')
  }
})

test('ensureAuthConfigMatchesMethod parses oauth2 with defaulted scopes', () => {
  const result = ensureAuthConfigMatchesMethod('oauth2', {
    method: 'oauth2',
    authorizationUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
  })
  assert.equal(result.method, 'oauth2')
  if (result.method === 'oauth2') {
    assert.deepEqual(result.scopes, [])
  }
})

test('ensureAuthConfigMatchesMethod rejects shape mismatch', () => {
  let thrown: unknown
  try {
    ensureAuthConfigMatchesMethod('api_key', { method: 'api_key' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal((thrown as McpCatalogError).code, MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID)
})

test('ensureAuthConfigMatchesMethod rejects method mismatch', () => {
  let thrown: unknown
  try {
    ensureAuthConfigMatchesMethod('bearer', { method: 'none' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal((thrown as McpCatalogError).code, MCP_CATALOG_ERROR_CODES.AUTH_METHOD_MISMATCH)
})

test('ensureAuthConfigMatchesMethod rejects entirely bogus payloads', () => {
  let thrown: unknown
  try {
    ensureAuthConfigMatchesMethod('none', { method: 'magic' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal((thrown as McpCatalogError).code, MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID)
})

// ─── publish / deprecate state machine (task #20) ───────────────────────────
//
// Lightweight in-memory stub for `prisma.mcpCatalogEntry` — keyed by id,
// matches the same OR-scoped lookup the real service uses so cross-org
// access still 404s through the stub.

type CatalogStub = {
  prisma: PrismaClient
  rows: Map<string, McpCatalogEntryRow>
}

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

const makeRow = (overrides: Partial<McpCatalogEntryRow> = {}): McpCatalogEntryRow => ({
  id: overrides.id ?? 'entry-1',
  organizationId: overrides.organizationId ?? ORG_A,
  name: overrides.name ?? 'demo-server',
  label: overrides.label ?? 'Demo Server',
  description: overrides.description ?? '',
  protocol: overrides.protocol ?? 'http',
  authMethod: overrides.authMethod ?? 'none',
  authConfig: overrides.authConfig ?? { method: 'none' },
  defaultTransportConfig: overrides.defaultTransportConfig ?? {},
  iconUrl: overrides.iconUrl ?? null,
  vendor: overrides.vendor ?? null,
  sourceUrl: overrides.sourceUrl ?? null,
  signature: overrides.signature ?? null,
  status: overrides.status ?? 'draft',
  createdBy: overrides.createdBy ?? 'actor-1',
  createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
})

const makeCatalogStub = (initial: McpCatalogEntryRow[]): CatalogStub => {
  const rows = new Map(initial.map((row) => [row.id, row]))
  const prisma = {
    mcpCatalogEntry: {
      findFirst: async ({ where }: { where: any }) => {
        const candidate = rows.get(where.id)
        if (!candidate) return null
        const orList = where.OR as Array<{ organizationId: string | null }>
        if (!orList) return candidate
        const matches = orList.some((clause) =>
          candidate.organizationId === clause.organizationId,
        )
        return matches ? candidate : null
      },
      update: async ({ where, data }: { where: { id: string }; data: any }) => {
        const existing = rows.get(where.id)
        if (!existing) throw new Error(`row ${where.id} missing`)
        const next: McpCatalogEntryRow = {
          ...existing,
          ...(data.status !== undefined ? { status: data.status } : {}),
        }
        rows.set(where.id, next)
        return next
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, rows }
}

test('publishCatalogEntry promotes a draft entry to published', async () => {
  const { prisma, rows } = makeCatalogStub([makeRow({ status: 'draft' })])
  const result = await publishCatalogEntry(prisma, ORG_A, 'entry-1')
  assert.ok(result)
  assert.equal(result?.status, 'published')
  assert.equal(rows.get('entry-1')?.status, 'published')
})

test('publishCatalogEntry is idempotent on an already-published entry', async () => {
  const { prisma } = makeCatalogStub([makeRow({ status: 'published' })])
  const result = await publishCatalogEntry(prisma, ORG_A, 'entry-1')
  assert.ok(result)
  assert.equal(result?.status, 'published')
})

test('publishCatalogEntry rejects re-publishing a deprecated entry', async () => {
  const { prisma } = makeCatalogStub([makeRow({ status: 'deprecated' })])
  let thrown: unknown
  try {
    await publishCatalogEntry(prisma, ORG_A, 'entry-1')
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpCatalogError)
  assert.equal(
    (thrown as McpCatalogError).code,
    MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
  )
})

test('publishCatalogEntry returns null for cross-org access', async () => {
  const { prisma } = makeCatalogStub([
    makeRow({ id: 'entry-orgB', organizationId: ORG_B, status: 'draft' }),
  ])
  const result = await publishCatalogEntry(prisma, ORG_A, 'entry-orgB')
  assert.equal(result, null)
})

test('publishCatalogEntry succeeds for a global (organizationId=null) entry', async () => {
  const { prisma } = makeCatalogStub([
    makeRow({ id: 'entry-global', organizationId: null, status: 'draft' }),
  ])
  const result = await publishCatalogEntry(prisma, ORG_A, 'entry-global')
  assert.ok(result)
  assert.equal(result?.status, 'published')
})

test('deprecateCatalogEntry marks a published entry deprecated', async () => {
  const { prisma, rows } = makeCatalogStub([makeRow({ status: 'published' })])
  const result = await deprecateCatalogEntry(prisma, ORG_A, 'entry-1')
  assert.ok(result)
  assert.equal(result?.status, 'deprecated')
  assert.equal(rows.get('entry-1')?.status, 'deprecated')
})

test('deprecateCatalogEntry is idempotent on already-deprecated entries', async () => {
  const { prisma } = makeCatalogStub([makeRow({ status: 'deprecated' })])
  const result = await deprecateCatalogEntry(prisma, ORG_A, 'entry-1')
  assert.ok(result)
  assert.equal(result?.status, 'deprecated')
})

test('deprecateCatalogEntry can deprecate a draft (skip publish)', async () => {
  const { prisma } = makeCatalogStub([makeRow({ status: 'draft' })])
  const result = await deprecateCatalogEntry(prisma, ORG_A, 'entry-1')
  assert.ok(result)
  assert.equal(result?.status, 'deprecated')
})

test('deprecateCatalogEntry returns null for cross-org access', async () => {
  const { prisma } = makeCatalogStub([
    makeRow({ id: 'entry-orgB', organizationId: ORG_B, status: 'published' }),
  ])
  const result = await deprecateCatalogEntry(prisma, ORG_A, 'entry-orgB')
  assert.equal(result, null)
})
