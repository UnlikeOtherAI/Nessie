import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'
import {
  collectStream,
  createFileService,
  type FileService,
  type Storage,
} from '@nessie/runtime'
import type { KnowledgeTransferJobPayload } from '@nessie/schemas'

import { executeKnowledgeTransferJob } from '../src/control/knowledge-transfer.js'

/**
 * The queued half of a transfer: batches, progress, and the failure semantics
 * that differ by operation.
 *
 * A move keeps the batches that committed — each rewrote its pages *and* their
 * chunks, so it is internally consistent — and a copy rolls everything back,
 * because a half-copy is a document that exists twice and is complete neither
 * time. Both are properties of committed rows, so this suite needs Postgres;
 * 250 pages is deliberately either side of the 200-page batch boundary.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const PAGE_COUNT = 250

type Seed = {
  prisma: PrismaClient
  organizationId: string
  projectId: string
  otherProjectId: string
  userId: string
  sourceSpaceId: string
  targetSpaceId: string
  rootId: string
  pageIdsInOrder: string[]
  blobs: Map<string, Buffer>
  fileService: FileService
}

const memoryStorage = (): Storage & { blobs: Map<string, Buffer> } => {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    putStream: async (key, body) => {
      const buffer = await collectStream(body)
      blobs.set(key, buffer)
      return { bytesWritten: buffer.length }
    },
    getStream: async (key) => (blobs.has(key) ? Readable.from(blobs.get(key) as Buffer) : null),
    put: async (key, bytes) => {
      blobs.set(key, bytes)
    },
    get: async (key) => blobs.get(key) ?? null,
    delete: async (key) => {
      blobs.delete(key)
    },
  }
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `xfer-job-${organizationId}` } })
  await prisma.user.create({
    data: { id: userId, email: `${userId}@transfer-job.test`, displayName: 'Job tester' },
  })
  const [source, target] = await Promise.all([
    prisma.project.create({ data: { organizationId, name: 'Source' } }),
    prisma.project.create({ data: { organizationId, name: 'Target' } }),
  ])
  const space = (name: string, projectId: string, visibility: 'project' | 'organization') =>
    prisma.knowledgeSpace.create({
      data: { organizationId, projectId, name, createdBy: userId, visibility },
      select: { id: true },
    })
  const [sourceSpace, targetSpace] = await Promise.all([
    space('Source docs', source.id, 'project'),
    space('Everyone', target.id, 'organization'),
  ])

  // One root folder with PAGE_COUNT - 1 children, and one chunk per page, in
  // raw SQL: the suite is about what a batched job does to 250 rows, not about
  // the provider's create path, and 250 round trips would make it a timing test.
  const rootId = randomUUID()
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO knowledge_pages
      (id, space_id, title, kind, status, organization_id, project_id, visibility,
       sensitivity_tier, created_by, position, created_at, updated_at)
    VALUES (${rootId}::uuid, ${sourceSpace.id}::uuid, 'Archive', 'folder', 'published',
            ${organizationId}::uuid, ${source.id}::uuid, 'project', 'normal', ${userId}, 0,
            now(), now())
  `)
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO knowledge_pages
      (id, space_id, parent_page_id, title, kind, status, organization_id, project_id,
       visibility, sensitivity_tier, created_by, position, created_at, updated_at)
    SELECT gen_random_uuid(), ${sourceSpace.id}::uuid, ${rootId}::uuid,
           'Note ' || n, 'document', 'published', ${organizationId}::uuid,
           ${source.id}::uuid, 'project', 'normal', ${userId}, n, now(), now()
    FROM generate_series(1, ${PAGE_COUNT - 1}) AS n
  `)
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO knowledge_page_versions (id, page_id, version_number, body, author_type, author_id)
    SELECT gen_random_uuid(), p.id, 1, '<p>' || p.title || ' body</p>', 'user', ${userId}
    FROM knowledge_pages p WHERE p.space_id = ${sourceSpace.id}::uuid
  `)
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO knowledge_page_chunks
      (page_id, version_id, chunk_index, content, content_hash, start_offset, end_offset,
       organization_id, project_id, visibility, sensitivity_tier, created_at, updated_at)
    SELECT v.page_id, v.id, 0, v.body, md5(v.body), 0, length(v.body),
           ${organizationId}::uuid, ${source.id}::uuid, 'project', 'normal', now(), now()
    FROM knowledge_page_versions v
    JOIN knowledge_pages p ON p.id = v.page_id
    WHERE p.space_id = ${sourceSpace.id}::uuid
  `)

  const ordered = await prisma.knowledgePage.findMany({
    where: { spaceId: sourceSpace.id },
    select: { id: true },
    orderBy: { position: 'asc' },
  })
  const storage = memoryStorage()
  return {
    prisma,
    organizationId,
    projectId: source.id,
    otherProjectId: target.id,
    userId,
    sourceSpaceId: sourceSpace.id,
    targetSpaceId: targetSpace.id,
    rootId,
    pageIdsInOrder: ordered.map((row) => row.id),
    blobs: storage.blobs,
    fileService: createFileService({ prisma, storage, maxUploadBytes: 1024 * 1024 }),
  }
}

const teardown = async (seeded: Seed): Promise<void> => {
  await seeded.prisma.organization.delete({ where: { id: seeded.organizationId } })
  await seeded.prisma.user.delete({ where: { id: seeded.userId } })
  await seeded.prisma.$disconnect()
}

const payloadFor = (
  seeded: Seed,
  transferId: string,
  operation: 'move' | 'copy',
): KnowledgeTransferJobPayload => ({
  organizationId: seeded.organizationId,
  transferId,
  operation,
  pageIds: [seeded.rootId],
  target: { spaceId: seeded.targetSpaceId, parentPageId: null },
  actor: { actorId: seeded.userId, actorType: 'user' },
  acknowledgedAudience: true,
})

// The route writes both of these before it answers 202; the job needs them to
// exist to clear the stamp and to report its progress.
const enqueueAndStamp = async (
  seeded: Seed,
  payload: KnowledgeTransferJobPayload,
): Promise<void> => {
  await seeded.prisma.$executeRaw(Prisma.sql`
    UPDATE knowledge_pages
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('transfer',
      jsonb_build_object('transferId', ${payload.transferId}, 'operation', ${payload.operation},
                         'targetSpaceId', ${payload.target.spaceId}, 'startedAt', now()::text))
    WHERE id = ${seeded.rootId}::uuid
  `)
  await seeded.prisma.$executeRaw(Prisma.sql`
    INSERT INTO queue_jobs (topic, payload, status, attempt, max_attempts, idempotency_key)
    VALUES ('knowledge.transfer', ${JSON.stringify(payload)}::jsonb, 'processing', 0, 1,
            ${`kb-transfer:${payload.transferId}`})
  `)
}

const jobProgress = async (
  seeded: Seed,
  transferId: string,
): Promise<{ done: number; total: number; error: string | null }> => {
  const rows = await seeded.prisma.$queryRaw<Array<{ progress: unknown }>>(Prisma.sql`
    SELECT payload -> 'progress' AS progress FROM queue_jobs
    WHERE idempotency_key = ${`kb-transfer:${transferId}`}
  `)
  return rows[0]?.progress as { done: number; total: number; error: string | null }
}

dbTest('a queued move rewrites every page and chunk in batches and reports progress', async () => {
  const seeded = await seed()
  try {
    const transferId = randomUUID()
    const payload = payloadFor(seeded, transferId, 'move')
    await enqueueAndStamp(seeded, payload)

    await executeKnowledgeTransferJob(
      { fileService: seeded.fileService, prisma: seeded.prisma },
      payload,
    )

    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.sourceSpaceId } }),
      0,
    )
    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.targetSpaceId } }),
      PAGE_COUNT,
    )
    // Not one chunk left answering the audience the pages just left — across
    // every batch, not only the last.
    assert.equal(
      await seeded.prisma.knowledgePageChunk.count({
        where: { organizationId: seeded.organizationId, projectId: seeded.projectId },
      }),
      0,
    )
    assert.equal(
      await seeded.prisma.knowledgePageChunk.count({
        where: {
          organizationId: seeded.organizationId,
          projectId: seeded.otherProjectId,
          visibility: 'organization',
        },
      }),
      PAGE_COUNT,
    )

    const progress = await jobProgress(seeded, transferId)
    assert.deepEqual(progress, { done: PAGE_COUNT, total: PAGE_COUNT, error: null })

    // The stamp always comes off: a row left reading "Moving…" refuses every
    // edit forever.
    const root = await seeded.prisma.knowledgePage.findUniqueOrThrow({
      where: { id: seeded.rootId },
    })
    assert.equal((root.metadata as Record<string, unknown> | null)?.['transfer'], undefined)
    assert.equal(root.parentPageId, null)
  } finally {
    await teardown(seeded)
  }
})

dbTest('a failed copy rolls back every page and byte the earlier batches created', async () => {
  const seeded = await seed()
  try {
    // One attachment in the first batch and one in the second, so the failure
    // lands with committed pages and stored bytes already behind it.
    const [first, second] = [seeded.pageIdsInOrder[1] as string, seeded.pageIdsInOrder[220] as string]
    for (const pageId of [first, second]) {
      await seeded.fileService.store({
        attribution: {
          organizationId: seeded.organizationId,
          actorId: seeded.userId,
          actorType: 'user',
          userId: seeded.userId,
        },
        organizationId: seeded.organizationId,
        uploaderId: seeded.userId,
        filename: 'note.txt',
        mime: 'text/plain',
        body: Readable.from(Buffer.from('some bytes')),
        knowledgePageId: pageId,
        scope: {
          projectId: seeded.projectId,
          teamId: null,
          spaceId: seeded.sourceSpaceId,
        },
      })
    }

    let copies = 0
    const failingFiles: FileService = {
      ...seeded.fileService,
      copy: async (attachmentId, input) => {
        copies += 1
        // The second attachment is in the second batch: the first batch's pages
        // and bytes are committed by the time this throws.
        if (copies > 1) throw new Error('storage is full')
        return seeded.fileService.copy(attachmentId, input)
      },
    }

    const transferId = randomUUID()
    const payload = payloadFor(seeded, transferId, 'copy')
    await enqueueAndStamp(seeded, payload)

    await assert.rejects(
      () => executeKnowledgeTransferJob(
        { fileService: failingFiles, prisma: seeded.prisma },
        payload,
      ),
      /storage is full/,
    )

    // Nothing lingers: no copied page, no copied attachment, and the source is
    // exactly as it was.
    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.targetSpaceId } }),
      0,
    )
    assert.equal(
      await seeded.prisma.attachment.count({ where: { organizationId: seeded.organizationId } }),
      2,
      'only the two source attachments survive',
    )
    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.sourceSpaceId } }),
      PAGE_COUNT,
    )
    const progress = await jobProgress(seeded, transferId)
    assert.equal(progress.done, 0, 'a rolled-back copy committed nothing, however far it got')
    assert.match(progress.error ?? '', /storage is full/)

    const root = await seeded.prisma.knowledgePage.findUniqueOrThrow({
      where: { id: seeded.rootId },
    })
    assert.equal((root.metadata as Record<string, unknown> | null)?.['transfer'], undefined)
  } finally {
    await teardown(seeded)
  }
})

dbTest('a queued move that fails mid-job keeps the batches that committed', async () => {
  const seeded = await seed()
  try {
    const transferId = randomUUID()
    const payload = payloadFor(seeded, transferId, 'move')
    await enqueueAndStamp(seeded, payload)

    let reassignments = 0
    const failingFiles: FileService = {
      ...seeded.fileService,
      reassignScope: async (ids, input) => {
        reassignments += 1
        // The second batch. The first has committed its rows, its chunk
        // mirrors and its ledger together; this one rolls back whole.
        if (reassignments === 2) throw new Error('ledger unavailable')
        return seeded.fileService.reassignScope(ids, input)
      },
    }

    await assert.rejects(
      () => executeKnowledgeTransferJob(
        { fileService: failingFiles, prisma: seeded.prisma },
        payload,
      ),
      /ledger unavailable/,
    )

    // The first batch stands and the rest stayed — and each half is internally
    // consistent, which is the whole reason a move may keep what it committed
    // where a copy may not. The batch that threw left not one page half-moved:
    // its rows, chunk mirrors and ledger pair are one transaction.
    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.targetSpaceId } }),
      200,
    )
    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.sourceSpaceId } }),
      PAGE_COUNT - 200,
    )
    assert.equal(
      await seeded.prisma.knowledgePageChunk.count({
        where: {
          organizationId: seeded.organizationId,
          projectId: seeded.otherProjectId,
          visibility: 'organization',
        },
      }),
      200,
      'every committed batch rewrote its chunks with its pages',
    )
    assert.equal(
      await seeded.prisma.knowledgePageChunk.count({
        where: { organizationId: seeded.organizationId, projectId: seeded.projectId },
      }),
      PAGE_COUNT - 200,
      'and the pages that stayed kept theirs',
    )
    // The tray's sentence — "Moved 200 of 250" — is this number.
    const progress = await jobProgress(seeded, transferId)
    assert.equal(progress.done, 200)
    assert.equal(progress.total, PAGE_COUNT)
    assert.match(progress.error ?? '', /ledger unavailable/)
  } finally {
    await teardown(seeded)
  }
})
