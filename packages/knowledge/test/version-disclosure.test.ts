import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'
import { type DisclosureViewer } from '@nessie/runtime'
import {
  KnowledgeConflictError,
  canReadKnowledgePageVersion,
  mergeVersionDisclosure,
  persistVersionDisclosure,
  type KnowledgePageVersionRecord,
} from '../src/index.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const channelId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const versionId = '00000000-0000-4000-8000-000000000004'

const version = (overrides: Partial<KnowledgePageVersionRecord> = {}): KnowledgePageVersionRecord => ({
  attachmentId: null,
  authorId: userId,
  authorType: 'user',
  basisScopes: [],
  body: '<p>private notes</p>',
  bodyRef: null,
  changeComment: null,
  createdAt: '2026-09-08T12:00:00.000Z',
  disclosureSources: [],
  id: versionId,
  pageId: '00000000-0000-4000-8000-000000000005',
  versionNumber: 1,
  ...overrides,
})

const viewer = (scopeRows: Array<{ scopeId: string; scopeType: string }>): DisclosureViewer => ({
  kind: 'user',
  scopes: scopeRows,
  userId,
})

test('version reader requires every retained source scope and fails closed for an explicit unknown author', () => {
  const scoped = version({
    basisScopes: [{ scopeId: channelId, scopeType: 'channel' }],
    disclosureSources: [{ sourceAuthorUserId: userId, sourceChannelId: channelId }],
  })
  assert.equal(canReadKnowledgePageVersion(scoped, viewer([])), false)
  assert.equal(
    canReadKnowledgePageVersion(scoped, viewer([{ scopeId: channelId, scopeType: 'channel' }])),
    true,
  )
  assert.equal(canReadKnowledgePageVersion(version({
    basisScopes: [{ scopeId: channelId, scopeType: 'channel' }],
    disclosureSources: [{ sourceAuthorUserId: null, sourceChannelId: channelId }],
  }), viewer([{ scopeId: channelId, scopeType: 'channel' }])), false)
})

test('mergeVersionDisclosure keeps inherited lineage and deduplicates the unknown-author marker', () => {
  const merged = mergeVersionDisclosure(
    {
      basisScopes: [{ scopeId: channelId, scopeType: 'channel' }],
      disclosureSources: [{ sourceAuthorUserId: null, sourceChannelId: channelId }],
    },
    {
      basisScopes: [{ scopeId: channelId, scopeType: 'channel' }],
      disclosureSources: [{ sourceAuthorUserId: null, sourceChannelId: channelId }],
    },
  )
  assert.deepEqual(merged.basisScopes, [{ scopeId: channelId, scopeType: 'channel' }])
  assert.deepEqual(merged.disclosureSources, [{ sourceAuthorUserId: null, sourceChannelId: channelId }])
})

test('restore retains both the current private boundary and the restored version boundary', () => {
  const currentChannelId = '00000000-0000-4000-8000-000000000006'
  const restored = mergeVersionDisclosure(
    {
      basisScopes: [{ scopeId: currentChannelId, scopeType: 'channel' }],
      disclosureSources: [{ sourceAuthorUserId: userId, sourceChannelId: currentChannelId }],
    },
    {
      basisScopes: [{ scopeId: channelId, scopeType: 'channel' }],
      disclosureSources: [{ sourceAuthorUserId: userId, sourceChannelId: channelId }],
    },
  )
  assert.deepEqual(restored.basisScopes, [
    { scopeId: currentChannelId, scopeType: 'channel' },
    { scopeId: channelId, scopeType: 'channel' },
  ])
  assert.equal(canReadKnowledgePageVersion(restored, viewer([
    { scopeId: channelId, scopeType: 'channel' },
  ])), false)
})

test('persistVersionDisclosure rejects malformed private lineage before writing either table', async () => {
  let writes = 0
  const tx = {
    channel: { findMany: async () => [] },
    agent: { findMany: async () => [] },
    knowledgePageVersionBasisScope: { createMany: async () => { writes += 1 } },
    knowledgePageVersionDisclosureSource: { createMany: async () => { writes += 1 } },
    message: { findFirst: async () => null },
    messageDisclosureSource: { findFirst: async () => null },
    project: { findMany: async () => [] },
    team: { findMany: async () => [] },
    user: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient

  await assert.rejects(
    persistVersionDisclosure(tx, {
      disclosure: { disclosureSources: [{ sourceAuthorUserId: userId, sourceChannelId: channelId }] },
      organizationId,
      versionId,
    }),
    KnowledgeConflictError,
  )
  assert.equal(writes, 0)
})

test('persistVersionDisclosure validates same-tenant channel and original author before idempotent writes', async () => {
  const writes: Array<{ table: string; rows: unknown[] }> = []
  const tx = {
    channel: { findMany: async () => [{ id: channelId }] },
    agent: { findMany: async () => [] },
    knowledgePageVersionBasisScope: {
      createMany: async ({ data }: { data: unknown[] }) => { writes.push({ table: 'basis', rows: data }) },
    },
    knowledgePageVersionDisclosureSource: {
      createMany: async ({ data }: { data: unknown[] }) => { writes.push({ table: 'source', rows: data }) },
    },
    message: { findFirst: async () => ({ id: 'message-1' }) },
    messageDisclosureSource: { findFirst: async () => null },
    project: { findMany: async () => [] },
    team: { findMany: async () => [] },
    user: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient

  await persistVersionDisclosure(tx, {
    disclosure: {
      basisScopes: [{ scopeId: channelId, scopeType: 'channel' }],
      disclosureSources: [{ sourceAuthorUserId: userId, sourceChannelId: channelId }],
    },
    organizationId,
    versionId,
  })
  assert.deepEqual(writes.map((write) => write.table), ['basis', 'source'])
})
