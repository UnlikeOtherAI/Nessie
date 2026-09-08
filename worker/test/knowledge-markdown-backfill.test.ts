import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { backfillMarkdownProjections } from '../src/control/knowledge-markdown-backfill.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const pageId = '00000000-0000-4000-8000-000000000002'
const versionId = '00000000-0000-4000-8000-000000000003'
const attachmentId = '00000000-0000-4000-8000-000000000004'
const source = '# Canonical note\n\nVerified bytes.'

const page = {
  channelId: null,
  id: pageId,
  organizationId,
  privateToAgentId: null,
  projectId: '00000000-0000-4000-8000-000000000005',
  sensitivityTier: 'normal',
  taskId: null,
  teamId: '00000000-0000-4000-8000-000000000006',
  threadId: null,
  userId: '00000000-0000-4000-8000-000000000007',
  visibility: 'project',
}

const makePrisma = (deletedDuringRead = false) => {
  let body: string | null = null
  let hash: string | null = null
  let chunked = false
  let queueWrites = 0
  const current = () => deletedDuringRead
    ? null
    : {
        attachmentId,
        body,
        chunks: chunked ? [{ embeddingModel: 'embedding-v1', id: 'chunk-1' }] : [],
        id: versionId,
        page,
        sourceContentHash: hash,
      }
  const tx = {
    $executeRaw: async (query: { sql: string }) => {
      if (query.sql.includes('INSERT INTO knowledge_page_chunks')) chunked = true
      if (query.sql.includes('INSERT INTO queue_jobs')) queueWrites += 1
      return 1
    },
    $queryRaw: async () => [],
    knowledgePageChunk: { deleteMany: async () => ({ count: 0 }) },
    knowledgePageVersion: {
      findFirst: async (args: { select?: { authorId?: boolean } }) =>
        args.select?.authorId
          ? { authorId: page.userId, authorType: 'user', page: { teamId: page.teamId, userId: page.userId } }
          : current(),
      update: async (args: { data: { body: string; sourceContentHash: string } }) => {
        body = args.data.body
        hash = args.data.sourceContentHash
        return current()
      },
    },
  }
  const prisma = {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
    attachment: {
      findUnique: async () => ({ filename: 'note.md', mime: 'text/markdown', organizationId }),
    },
    knowledgePageVersion: {
      findMany: async () => [{ attachmentId, id: versionId, page: { id: pageId, organizationId } }],
    },
  } as unknown as PrismaClient
  return { prisma, queueWrites: () => queueWrites }
}

test('Markdown backfill repairs a version once and resumes without another projection or queue write', async () => {
  const fixture = makePrisma()
  const dependencies = {
    embeddingModel: 'embedding-v1',
    prisma: fixture.prisma,
    readMarkdownAttachment: async () => Readable.from([source]),
  }

  const first = await backfillMarkdownProjections(dependencies, { organizationId })
  assert.deepEqual(first, {
    chunked: 1,
    examined: 1,
    nextCursor: null,
    projected: 1,
    queued: 1,
    skippedConcurrentChange: 0,
    skippedWithoutEmbeddingModel: 0,
    skippedWithoutOrigin: 0,
  })
  assert.equal(fixture.queueWrites(), 1)

  const second = await backfillMarkdownProjections(dependencies, { organizationId })
  assert.equal(second.projected, 0)
  assert.equal(second.chunked, 0)
  assert.equal(second.queued, 0)
  assert.equal(fixture.queueWrites(), 1)
})

test('Markdown backfill does not restore a concurrently deleted file page', async () => {
  const fixture = makePrisma(true)
  const result = await backfillMarkdownProjections({
    embeddingModel: 'embedding-v1',
    prisma: fixture.prisma,
    readMarkdownAttachment: async () => Readable.from([source]),
  }, { organizationId })

  assert.equal(result.skippedConcurrentChange, 1)
  assert.equal(result.projected, 0)
  assert.equal(result.chunked, 0)
  assert.equal(fixture.queueWrites(), 0)
})
