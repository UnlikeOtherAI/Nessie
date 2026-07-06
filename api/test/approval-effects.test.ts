import assert from 'node:assert/strict'
import test from 'node:test'

import type { KnowledgePageRecord } from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { runApprovalEffect } from '../src/services/approval-effects.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const pageId = '00000000-0000-4000-8000-000000000005'
const versionId = '00000000-0000-4000-8000-000000000006'
const staleVersionId = '00000000-0000-4000-8000-000000000007'
const spaceId = '00000000-0000-4000-8000-000000000004'

const actorContext: AuthorizedActionContext = {
  actor: { actorType: 'user', actorId: 'user-1', roles: ['owner'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: 'req-effect-test' },
}

const makePage = (overrides: Partial<KnowledgePageRecord> = {}): KnowledgePageRecord => ({
  id: pageId,
  spaceId,
  title: 'Runbook',
  summary: null,
  metadata: null,
  kind: 'document',
  parentPageId: null,
  position: 0,
  status: 'draft',
  labels: [],
  latestVersion: {
    id: versionId,
    pageId,
    versionNumber: 2,
    body: '<p>updated</p>',
    bodyRef: null,
    attachmentId: null,
    authorType: 'agent',
    authorId: 'agent-1',
    changeComment: null,
    createdAt: '2026-05-31T10:00:00.000Z',
  },
  publishedVersion: null,
  publishedVersionId: null,
  organizationId,
  projectId,
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  privateToAgentId: null,
  createdBy: 'agent-1',
  deletedAt: null,
  createdAt: '2026-05-31T10:00:00.000Z',
  updatedAt: '2026-05-31T10:00:00.000Z',
  ...overrides,
})

// approval-effects.ts imports createNativeKnowledgeProvider directly rather
// than accepting one, so these tests stub the underlying prisma calls the
// native provider makes (getPage / publishPage) instead of the provider
// itself. auditLog.create is stubbed to observe the audit emission.
const buildFakePrisma = (options: {
  page?: ReturnType<typeof makePage> | null
  publishedPage?: ReturnType<typeof makePage> | null
} = {}) => {
  const auditLogs: Array<Record<string, unknown>> = []
  const page = 'page' in options ? options.page : makePage()
  const publishedPage = options.publishedPage ?? makePage({ status: 'published', publishedVersionId: versionId })

  const toRow = (record: KnowledgePageRecord) => ({
    id: record.id,
    spaceId: record.spaceId,
    title: record.title,
    summary: record.summary,
    metadata: record.metadata,
    kind: record.kind,
    parentPageId: record.parentPageId,
    position: record.position,
    status: record.status,
    labels: [],
    versions: record.latestVersion ? [{ ...record.latestVersion, createdAt: new Date(record.latestVersion.createdAt) }] : [],
    publishedVersion: null,
    publishedVersionId: record.publishedVersionId,
    organizationId: record.organizationId,
    projectId: record.projectId,
    teamId: record.teamId,
    channelId: record.channelId,
    threadId: record.threadId,
    userId: record.userId,
    visibility: record.visibility,
    sensitivityTier: record.sensitivityTier,
    privateToAgentId: record.privateToAgentId,
    createdBy: record.createdBy,
    deletedAt: null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  })

  let currentPageRow = page ? toRow(page) : null

  const prisma = {
    knowledgePage: {
      findFirst: async () => currentPageRow,
      update: async () => {
        currentPageRow = toRow(publishedPage)
        return currentPageRow
      },
    },
    knowledgePageVersion: {
      findFirst: async () => currentPageRow?.versions[0] ?? null,
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data)
      },
    },
    // publishPage's chunk-indexing step (replaceKnowledgePageVersionChunks)
    // runs a raw existence check then a raw insert against
    // knowledge_page_chunks — stubbed as "no chunks yet, insert a no-op" so
    // the transaction completes without a real database.
    $queryRaw: async () => [],
    $executeRaw: async () => undefined,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  }
  return { prisma, auditLogs }
}

test('runApprovalEffect is a no-op for an unrelated action', async () => {
  const { prisma, auditLogs } = buildFakePrisma()
  const result = await runApprovalEffect(
    prisma as never,
    { id: 'approval-1', action: 'thread.pin', context: {} },
    actorContext,
  )

  assert.deepEqual(result, {})
  assert.equal(auditLogs.length, 0)
})

test('runApprovalEffect refuses to publish a stale draft (newer version since the request)', async () => {
  const { prisma, auditLogs } = buildFakePrisma()
  const result = await runApprovalEffect(
    prisma as never,
    {
      id: 'approval-1',
      action: 'knowledge.page.publish',
      context: { pageId, versionId: staleVersionId, spaceId, title: 'Runbook' },
    },
    actorContext,
  )

  assert.match(result.note ?? '', /superseded by a newer version/)
  assert.equal(auditLogs.length, 0)
})

test('runApprovalEffect publishes the page and emits an audit event on the happy path', async () => {
  const { prisma, auditLogs } = buildFakePrisma()
  const result = await runApprovalEffect(
    prisma as never,
    {
      id: 'approval-1',
      action: 'knowledge.page.publish',
      context: { pageId, versionId, spaceId, title: 'Runbook' },
    },
    actorContext,
  )

  assert.equal(result.note, 'published')
  assert.equal(auditLogs.length, 1)
  assert.equal(auditLogs[0]?.['action'], 'kb.page.published')
  assert.equal(auditLogs[0]?.['resourceType'], 'knowledge_page')
})

test('runApprovalEffect reports a missing page without throwing', async () => {
  const { prisma, auditLogs } = buildFakePrisma({ page: null })
  const result = await runApprovalEffect(
    prisma as never,
    {
      id: 'approval-1',
      action: 'knowledge.page.publish',
      context: { pageId, versionId, spaceId, title: 'Runbook' },
    },
    actorContext,
  )

  assert.equal(result.note, 'page no longer exists')
  assert.equal(auditLogs.length, 0)
})
