import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
  createCatalogEntry,
  deprecateCatalogEntry,
  ensureAuthConfigMatchesMethod,
  listCatalogEntries,
  publishCatalogEntry,
  updateCatalogEntry,
  type McpCatalogEntryRow,
} from '../src/services/mcp-catalog.js'
import {
  approveSubmission,
  rejectSubmission,
  submitForReview,
} from '../src/services/mcp-catalog-review.js'

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
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  })
  assert.equal(result.method, 'oauth2')
  if (result.method === 'oauth2') {
    assert.deepEqual(result.scopes, [])
  }
})

test('ensureAuthConfigMatchesMethod rejects shape mismatch', () => {
  assert.throws(
    () => ensureAuthConfigMatchesMethod('api_key', { method: 'api_key' }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID,
  )
})

test('ensureAuthConfigMatchesMethod rejects method mismatch', () => {
  assert.throws(
    () => ensureAuthConfigMatchesMethod('bearer', { method: 'none' }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.AUTH_METHOD_MISMATCH,
  )
})

test('createCatalogEntry rejects user-authored stdio connectors', async () => {
  const { prisma } = makeStub([])
  await assert.rejects(
    () => createCatalogEntry(prisma, actorCtx(USER_A), {
      name: 'stdio-tool',
      label: 'Stdio Tool',
      protocol: 'stdio',
      authMethod: 'none',
      authConfig: { method: 'none' },
      defaultTransportConfig: { transport: 'stdio', command: 'node' },
    }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
  )
})

test('createCatalogEntry rejects MCP HTTP URLs that target local networks', async () => {
  const { prisma } = makeStub([])
  await assert.rejects(
    () => createCatalogEntry(prisma, actorCtx(USER_A), {
      name: 'local-tool',
      label: 'Local Tool',
      protocol: 'http',
      authMethod: 'none',
      authConfig: { method: 'none' },
      defaultTransportConfig: {
        transport: 'http',
        url: 'http://127.0.0.1:5454/mcp',
      },
    }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
  )
})

// ─── In-memory catalog stub ─────────────────────────────────────────────────
//
// A small generic stub that matches Prisma `where` clauses field-by-field
// (including `OR`) so the visibility/ownership predicates the service builds
// exercise the same logic they would against Postgres.

const USER_A = '00000000-0000-4000-8000-0000000000a1'
const USER_B = '00000000-0000-4000-8000-0000000000b2'
const ADMIN = '00000000-0000-4000-8000-0000000000c3'
const ORG_A = '00000000-0000-4000-8000-00000000000a'

const actorCtx = (
  actorId: string,
  roles: string[] = [],
): AuthorizedActionContext =>
  ({
    actor: { actorType: 'user', actorId, roles },
    tenant: { organizationId: ORG_A },
  }) as unknown as AuthorizedActionContext

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
  visibility: overrides.visibility ?? 'private',
  ownerUserId: overrides.ownerUserId ?? USER_A,
  submittedAt: overrides.submittedAt ?? null,
  reviewedAt: overrides.reviewedAt ?? null,
  reviewedBy: overrides.reviewedBy ?? null,
  rejectionReason: overrides.rejectionReason ?? null,
  createdBy: overrides.createdBy ?? USER_A,
  createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
})

const matchesWhere = (row: McpCatalogEntryRow, where: Record<string, unknown>): boolean => {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      const ok = (value as Array<Record<string, unknown>>).some((clause) =>
        matchesWhere(row, clause),
      )
      if (!ok) return false
      continue
    }
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false
  }
  return true
}

type CatalogStub = { prisma: PrismaClient; rows: Map<string, McpCatalogEntryRow> }

const makeStub = (initial: McpCatalogEntryRow[]): CatalogStub => {
  const rows = new Map(initial.map((row) => [row.id, row]))
  const prisma = {
    mcpCatalogEntry: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((row) => matchesWhere(row, where ?? {})),
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Record<string, unknown>
      }) => {
        const existing = rows.get(where.id)
        if (!existing) throw new Error(`row ${where.id} missing`)
        const next = { ...existing, ...data } as McpCatalogEntryRow
        rows.set(where.id, next)
        return next
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        const matched = [...rows.values()].filter((row) => matchesWhere(row, where))
        for (const row of matched) rows.set(row.id, { ...row, ...data } as McpCatalogEntryRow)
        return { count: matched.length }
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = makeRow(data as Partial<McpCatalogEntryRow>)
        const id = (data.id as string | undefined) ?? `entry-${rows.size + 1}`
        const next = { ...row, id }
        rows.set(id, next)
        return next
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, rows }
}

// ─── create ─────────────────────────────────────────────────────────────────

test('createCatalogEntry starts private + draft, owned by the author', async () => {
  const { prisma } = makeStub([])
  const entry = await createCatalogEntry(prisma, actorCtx(USER_A), {
    name: 'my-tool',
    label: 'My Tool',
    protocol: 'http',
    authMethod: 'none',
    authConfig: { method: 'none' },
  })
  assert.equal(entry.visibility, 'private')
  assert.equal(entry.status, 'draft')
  assert.equal(entry.ownerUserId, USER_A)
  assert.equal(entry.createdBy, USER_A)
})

// ─── private self-publish ─────────────────────────────────────────────────

test('publishCatalogEntry self-publishes a private draft for its owner', async () => {
  const { prisma, rows } = makeStub([makeRow({ status: 'draft', ownerUserId: USER_A })])
  const result = await publishCatalogEntry(prisma, actorCtx(USER_A), 'entry-1')
  assert.equal(result?.status, 'published')
  assert.equal(rows.get('entry-1')?.status, 'published')
})

test('publishCatalogEntry refuses public entries (use the review flow)', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  await assert.rejects(
    () => publishCatalogEntry(prisma, actorCtx(USER_A), 'entry-1'),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
  )
})

test('publishCatalogEntry returns null when the entry is not visible to the actor', async () => {
  const { prisma } = makeStub([makeRow({ status: 'draft', ownerUserId: USER_A })])
  const result = await publishCatalogEntry(prisma, actorCtx(USER_B), 'entry-1')
  assert.equal(result, null)
})

test('publishCatalogEntry lets a superuser publish any private draft', async () => {
  const { prisma } = makeStub([makeRow({ status: 'draft', ownerUserId: USER_A })])
  const result = await publishCatalogEntry(prisma, actorCtx(ADMIN, ['owner']), 'entry-1')
  assert.equal(result?.status, 'published')
})

// ─── update permission ──────────────────────────────────────────────────────

test('updateCatalogEntry forbids a non-owner editing a public published entry', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'published', visibility: 'public', ownerUserId: USER_A }),
  ])
  await assert.rejects(
    () => updateCatalogEntry(prisma, actorCtx(USER_B), 'entry-1', { label: 'Hijack' }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.FORBIDDEN,
  )
})

// ─── submit for review ──────────────────────────────────────────────────────

test('submitForReview flips a private draft to a public pending submission', async () => {
  const { prisma, rows } = makeStub([makeRow({ status: 'draft', ownerUserId: USER_A })])
  const result = await submitForReview(prisma, actorCtx(USER_A), 'entry-1')
  assert.equal(result?.status, 'pending_approval')
  assert.equal(result?.visibility, 'public')
  assert.ok(rows.get('entry-1')?.submittedAt)
})

test('submitForReview rejects submitting an already-published entry', async () => {
  const { prisma } = makeStub([makeRow({ status: 'published', ownerUserId: USER_A })])
  await assert.rejects(
    () => submitForReview(prisma, actorCtx(USER_A), 'entry-1'),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
  )
})

// ─── approve / reject (superuser) ───────────────────────────────────────────

test('approveSubmission publishes a pending submission', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  const result = await approveSubmission(prisma, actorCtx(ADMIN, ['owner']), 'entry-1')
  assert.equal(result?.status, 'published')
  assert.equal(result?.visibility, 'public')
  assert.equal(result?.reviewedBy, ADMIN)
})

test('approveSubmission forbids non-superusers (even the submitter)', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  await assert.rejects(
    () => approveSubmission(prisma, actorCtx(USER_A), 'entry-1'),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.FORBIDDEN,
  )
})

test('approveSubmission rejects entries that are not awaiting approval', async () => {
  const { prisma } = makeStub([makeRow({ status: 'draft', ownerUserId: USER_A })])
  await assert.rejects(
    () => approveSubmission(prisma, actorCtx(ADMIN, ['owner']), 'entry-1'),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
  )
})

test('rejectSubmission reverts to a private rejected draft with the reason', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  const result = await rejectSubmission(
    prisma,
    actorCtx(ADMIN, ['owner']),
    'entry-1',
    'Needs a clearer description',
  )
  assert.equal(result?.status, 'rejected')
  assert.equal(result?.visibility, 'private')
  assert.equal(result?.rejectionReason, 'Needs a clearer description')
  assert.equal(result?.reviewedBy, ADMIN)
})

test('rejectSubmission forbids non-superusers', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  await assert.rejects(
    () => rejectSubmission(prisma, actorCtx(USER_A), 'entry-1', 'no'),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.FORBIDDEN,
  )
})

// ─── deprecate ──────────────────────────────────────────────────────────────

test('deprecateCatalogEntry marks a published entry deprecated for its owner', async () => {
  const { prisma, rows } = makeStub([makeRow({ status: 'published', ownerUserId: USER_A })])
  const result = await deprecateCatalogEntry(prisma, actorCtx(USER_A), 'entry-1')
  assert.equal(result?.status, 'deprecated')
  assert.equal(rows.get('entry-1')?.status, 'deprecated')
})

// ─── visibility-scoped listing ──────────────────────────────────────────────

test('listCatalogEntries store view returns only public published entries', async () => {
  const { prisma } = makeStub([
    makeRow({ id: 'pub', status: 'published', visibility: 'public', ownerUserId: null }),
    makeRow({ id: 'mine-draft', status: 'draft', ownerUserId: USER_B }),
    makeRow({ id: 'pending', status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  const entries = await listCatalogEntries(prisma, actorCtx(USER_B), { view: 'store' })
  assert.deepEqual(entries.map((entry) => entry.id), ['pub'])
})

test('listCatalogEntries mine view returns the actor own entries in any state', async () => {
  const { prisma } = makeStub([
    makeRow({ id: 'pub', status: 'published', visibility: 'public', ownerUserId: null }),
    makeRow({ id: 'mine-draft', status: 'draft', ownerUserId: USER_B }),
    makeRow({ id: 'mine-rejected', status: 'rejected', ownerUserId: USER_B }),
  ])
  const entries = await listCatalogEntries(prisma, actorCtx(USER_B), { view: 'mine' })
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ['mine-draft', 'mine-rejected'])
})

test('listCatalogEntries store view ignores a status sub-filter (no queue leak)', async () => {
  const { prisma } = makeStub([
    makeRow({ id: 'pub', status: 'published', visibility: 'public', ownerUserId: null }),
    makeRow({ id: 'pending', status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  // A non-superuser must not be able to widen the store into the review queue.
  const entries = await listCatalogEntries(prisma, actorCtx(USER_B), {
    view: 'store',
    status: 'pending_approval',
  })
  assert.deepEqual(entries.map((entry) => entry.id), ['pub'])
})

test('deprecateCatalogEntry refuses non-published entries', async () => {
  const { prisma } = makeStub([makeRow({ status: 'draft', ownerUserId: USER_A })])
  await assert.rejects(
    () => deprecateCatalogEntry(prisma, actorCtx(USER_A), 'entry-1'),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
  )
})

test('updateCatalogEntry refuses edits while a submission is under review', async () => {
  const { prisma } = makeStub([
    makeRow({ status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
  ])
  await assert.rejects(
    () => updateCatalogEntry(prisma, actorCtx(USER_A), 'entry-1', { label: 'Sneaky' }),
    (error: unknown) =>
      error instanceof McpCatalogError
      && error.code === MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
  )
})

test('listCatalogEntries queue view returns pending submissions', async () => {
  const { prisma } = makeStub([
    makeRow({ id: 'pending', status: 'pending_approval', visibility: 'public', ownerUserId: USER_A }),
    makeRow({ id: 'pub', status: 'published', visibility: 'public', ownerUserId: null }),
  ])
  const entries = await listCatalogEntries(prisma, actorCtx(ADMIN, ['owner']), { view: 'queue' })
  assert.deepEqual(entries.map((entry) => entry.id), ['pending'])
})
