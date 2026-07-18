import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Attachment, PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import { executeKnowledgeExtractJob } from '../src/control/knowledge-extract.js'

type SqlLike = { sql: string; values: unknown[] }
type CapturedCall = { sql: string; values: unknown[] }

type PageRow = {
  id: string
  organizationId: string
  projectId: string
  teamId: string | null
  channelId: string | null
  threadId: string | null
  userId: string | null
  visibility: string
  sensitivityTier: string
  privateToAgentId: string | null
}

const PAGE: PageRow = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '44444444-4444-4444-4444-444444444444',
  projectId: '22222222-2222-2222-2222-222222222222',
  teamId: '33333333-3333-3333-3333-333333333333',
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'project',
  sensitivityTier: 'normal',
  privateToAgentId: null,
}

const ATTACHMENT_ID = '55555555-5555-5555-5555-555555555555'
const VERSION_ID = '66666666-6666-6666-6666-666666666666'

const PAYLOAD = {
  organizationId: PAGE.organizationId,
  origin: {
    actorId: '77777777-7777-4777-8777-777777777777',
    actorType: 'user' as const,
    agentId: '88888888-8888-4888-8888-888888888888',
    requestId: 'knowledge-file-request-1',
    runId: '99999999-9999-4999-8999-999999999999',
    systemComponent: 'knowledge-file-indexer',
    teamId: '33333333-3333-3333-3333-333333333333',
    userId: '77777777-7777-4777-8777-777777777777',
  },
  pageId: PAGE.id,
  versionId: VERSION_ID,
  attachmentId: ATTACHMENT_ID,
}

const baseAttachment = (overrides: Partial<Attachment> = {}): Attachment =>
  ({
    id: ATTACHMENT_ID,
    organizationId: PAGE.organizationId,
    uploaderId: null,
    messageId: null,
    knowledgePageId: PAGE.id,
    kind: 'text',
    mime: 'text/plain',
    filename: 'notes.txt',
    sizeBytes: BigInt(1024),
    storageKey: 'org/key',
    width: null,
    height: null,
    createdAt: new Date(),
    ...overrides,
  }) as Attachment

type PrismaStubOpts = {
  page: PageRow | null
  version: { attachmentId: string | null } | null
  attachment: Attachment | null
  existingChunks: boolean
  executeRawCalls: CapturedCall[]
  queryRawCalls: CapturedCall[]
  attachmentLookups: number[]
}

const buildPrismaStub = (opts: PrismaStubOpts): PrismaClient => {
  let attachmentLookupCount = 0
  return {
    knowledgePage: {
      findFirst: async () => opts.page,
    },
    knowledgePageVersion: {
      findFirst: async () => opts.version,
    },
    attachment: {
      findUnique: async () => {
        attachmentLookupCount += 1
        opts.attachmentLookups.push(attachmentLookupCount)
        return opts.attachment
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        $queryRaw: async (query: SqlLike) => {
          opts.queryRawCalls.push({ sql: query.sql, values: query.values })
          return opts.existingChunks ? [{ present: 1 }] : []
        },
        $executeRaw: async (query: SqlLike) => {
          opts.executeRawCalls.push({ sql: query.sql, values: query.values })
          return 1
        },
      }
      return fn(tx)
    },
  } as unknown as PrismaClient
}

// `calls` is a mutable holder (not a plain number) so callers can read the
// live count after awaiting the job — a returned primitive would just be a
// snapshot of 0 taken before openStream was ever invoked.
const buildFileService = (
  opened: { stream: Readable; attachment: Attachment } | null,
): { fileService: FileService; calls: { count: number } } => {
  const calls = { count: 0 }
  const fileService = {
    openStream: async () => {
      calls.count += 1
      return opened
    },
  } as unknown as FileService
  return { fileService, calls }
}

const textStream = (text: string): Readable => Readable.from([Buffer.from(text, 'utf8')])

// A body long enough that the chunker keeps it as real content (mirrors the
// kind of extracted text a real file upload would produce).
const LONG_TEXT =
  'Storage quota is enforced before uploads and every blob operation goes through FileService. '.repeat(6)

test('executeKnowledgeExtractJob skips a non-extractable upload without reading bytes', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment: baseAttachment({ mime: 'image/png', filename: 'photo.png' }),
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService, calls: openStreamCalls } = buildFileService(null)

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(openStreamCalls.count, 0)
  assert.equal(executeRawCalls.length, 0)
  assert.equal(queryRawCalls.length, 0)
})

test('executeKnowledgeExtractJob skips an oversized attachment without reading bytes', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment: baseAttachment({ sizeBytes: BigInt(21 * 1024 * 1024) }),
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService, calls: openStreamCalls } = buildFileService(null)

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(openStreamCalls.count, 0)
  assert.equal(executeRawCalls.length, 0)
})

test('executeKnowledgeExtractJob returns silently on version/attachment mismatch', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: 'a-different-attachment-id' },
    attachment: baseAttachment(),
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService, calls: openStreamCalls } = buildFileService(null)

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(attachmentLookups.length, 0, 'should not even look up the attachment row')
  assert.equal(openStreamCalls.count, 0)
  assert.equal(executeRawCalls.length, 0)
})

test('executeKnowledgeExtractJob returns silently when the page is missing', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const prisma = buildPrismaStub({
    page: null,
    version: { attachmentId: ATTACHMENT_ID },
    attachment: baseAttachment(),
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService, calls: openStreamCalls } = buildFileService(null)

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(openStreamCalls.count, 0)
  assert.equal(executeRawCalls.length, 0)
})

test('executeKnowledgeExtractJob chunks plain text and enqueues knowledge.embed', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const attachment = baseAttachment()
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment,
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService, calls: openStreamCalls } = buildFileService({
    stream: textStream(LONG_TEXT),
    attachment,
  })

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(openStreamCalls.count, 1)
  assert.equal(queryRawCalls.length, 1)
  assert.ok(queryRawCalls[0]!.sql.includes('SELECT 1 AS present'))
  assert.equal(executeRawCalls.length, 2)
  assert.ok(executeRawCalls[0]!.sql.includes('INSERT INTO knowledge_page_chunks'))
  assert.ok(executeRawCalls[0]!.values.includes(PAGE.id))
  assert.ok(executeRawCalls[1]!.sql.includes('INSERT INTO queue_jobs'))
  assert.ok(executeRawCalls[1]!.values.includes('knowledge.embed'))
  assert.ok(executeRawCalls[1]!.values.includes(`kb-embed:${PAGE.id}:${VERSION_ID}`))
})

test('executeKnowledgeExtractJob is a no-op when chunks already exist for the version', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const attachment = baseAttachment()
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment,
    existingChunks: true,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService } = buildFileService({ stream: textStream(LONG_TEXT), attachment })

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(queryRawCalls.length, 1)
  assert.equal(executeRawCalls.length, 0, 'no chunk insert and no embed enqueue')
})

test('executeKnowledgeExtractJob returns without indexing when extracted text is blank', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const attachment = baseAttachment()
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment,
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService } = buildFileService({ stream: textStream('   \n\n  \t '), attachment })

  await executeKnowledgeExtractJob({ fileService, prisma }, PAYLOAD)

  assert.equal(queryRawCalls.length, 0)
  assert.equal(executeRawCalls.length, 0)
})

test('executeKnowledgeExtractJob wires the injected pdf parser and buffers the whole stream', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const attachment = baseAttachment({ mime: 'application/pdf', filename: 'report.pdf' })
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment,
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService } = buildFileService({
    stream: Readable.from([Buffer.from('%PDF-fake-bytes'), Buffer.from('-more-bytes')]),
    attachment,
  })

  let parsePdfCalledWith: Buffer | null = null
  await executeKnowledgeExtractJob(
    {
      fileService,
      prisma,
      parsePdf: async (buffer) => {
        parsePdfCalledWith = buffer
        return { text: LONG_TEXT }
      },
    },
    PAYLOAD,
  )

  assert.ok(parsePdfCalledWith)
  assert.equal((parsePdfCalledWith as Buffer).toString('utf8'), '%PDF-fake-bytes-more-bytes')
  assert.equal(executeRawCalls.length, 2)
  assert.ok(executeRawCalls[0]!.sql.includes('INSERT INTO knowledge_page_chunks'))
})

test('executeKnowledgeExtractJob wires the injected docx extractor', async () => {
  const executeRawCalls: CapturedCall[] = []
  const queryRawCalls: CapturedCall[] = []
  const attachmentLookups: number[] = []
  const attachment = baseAttachment({
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'report.docx',
  })
  const prisma = buildPrismaStub({
    page: PAGE,
    version: { attachmentId: ATTACHMENT_ID },
    attachment,
    existingChunks: false,
    executeRawCalls,
    queryRawCalls,
    attachmentLookups,
  })
  const { fileService } = buildFileService({
    stream: Readable.from([Buffer.from('PK-fake-docx-bytes')]),
    attachment,
  })

  let extractDocxCalledWith: Buffer | null = null
  await executeKnowledgeExtractJob(
    {
      fileService,
      prisma,
      extractDocxText: async (buffer) => {
        extractDocxCalledWith = buffer
        return { value: LONG_TEXT }
      },
    },
    PAYLOAD,
  )

  assert.ok(extractDocxCalledWith)
  assert.equal((extractDocxCalledWith as Buffer).toString('utf8'), 'PK-fake-docx-bytes')
  assert.equal(executeRawCalls.length, 2)
  assert.ok(executeRawCalls[0]!.sql.includes('INSERT INTO knowledge_page_chunks'))
})
