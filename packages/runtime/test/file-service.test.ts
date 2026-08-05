import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createFileService, QuotaExceededError } from '../src/files/index.js'
import { collectStream, type Storage } from '../src/storage/index.js'

const ORG = '00000000-0000-4000-8000-000000000001'

const attribution = { organizationId: ORG, actorId: 'user-1', actorType: 'user' as const }

// In-memory Storage that records bytes per key.
const makeStorage = (): Storage & { blobs: Map<string, Buffer> } => {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    putStream: async (key, body) => {
      const buf = await collectStream(body)
      blobs.set(key, buf)
      return { bytesWritten: buf.length }
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

type UsageRow = {
  organizationId: string
  projectId: string | null
  teamId: string | null
  spaceId: string | null
  uploaderId: string | null
  deltaBytes: bigint
}

type BudgetRow = { scopeType: string; scopeId: string; storageLimitBytes: bigint | null }

// Minimal in-memory Prisma surface covering exactly what FileService touches.
const makePrisma = (budgets: BudgetRow[] = []) => {
  const attachments = new Map<string, Record<string, unknown>>()
  const usage: UsageRow[] = []
  let seq = 0
  const matches = (row: UsageRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value)

  const prisma = {
    attachment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1
        const row = {
          id: `att-${seq}`,
          width: null,
          height: null,
          messageId: null,
          knowledgePageId: null,
          // Prisma returns NULL for nullable columns the create omitted.
          thumbnailKey: null,
          thumbnailMime: null,
          thumbnailSizeBytes: null,
          thumbnailWidth: null,
          thumbnailHeight: null,
          thumbnailStatus: null,
          ...data,
        }
        attachments.set(row.id as string, row)
        return row
      },
      findUnique: async ({ where }: { where: { id: string } }) => attachments.get(where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        const row = attachments.get(where.id as string)
        // Mirrors the conditional claim FileService relies on: a row that
        // already has a thumbnailKey does not match `thumbnailKey: null`.
        if (!row || ('thumbnailKey' in where && row.thumbnailKey !== where.thumbnailKey)) {
          return { count: 0 }
        }
        Object.assign(row, data)
        return { count: 1 }
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = attachments.get(where.id)
        attachments.delete(where.id)
        return row
      },
    },
    storageUsageEvent: {
      create: async ({ data }: { data: UsageRow }) => {
        usage.push(data)
        return data
      },
      aggregate: async ({ where }: { where: Record<string, unknown> }) => {
        const sum = usage
          .filter((row) => matches(row, where))
          .reduce((acc, row) => acc + BigInt(row.deltaBytes), 0n)
        return { _sum: { deltaBytes: sum } }
      },
    },
    budget: {
      findMany: async () => budgets,
    },
    knowledgePage: {
      findUnique: async () => null,
    },
  }
  return prisma as unknown as PrismaClient
}

test('store records a positive usage delta and delete records a negative one', async () => {
  const prisma = makePrisma()
  const storage = makeStorage()
  const files = createFileService({ prisma, storage, maxUploadBytes: 1_000_000 })

  const { attachment, bytesWritten } = await files.store({
    attribution,
    organizationId: ORG,
    uploaderId: 'user-1',
    filename: 'sheet.xlsx',
    mime: 'application/vnd.ms-excel',
    body: Readable.from(Buffer.from('hello world')),
  })

  assert.equal(bytesWritten, 11)
  assert.equal(attachment.sizeBytes, 11n)
  // One object: a spreadsheet has no preview. The image case — where a second
  // object exists and must also be freed — is covered below and in
  // file-service-strip-metadata.test.ts.
  assert.equal(storage.blobs.size, 1)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '11')

  const deleted = await files.delete(attachment.id, ORG, attribution)
  assert.equal(deleted, true)
  assert.equal(storage.blobs.size, 0)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '0')
})

test('a thumbnail attached after the fact is stored, metered, and freed with the file', async () => {
  const prisma = makePrisma()
  const storage = makeStorage()
  const files = createFileService({ prisma, storage, maxUploadBytes: 1_000_000 })

  const { attachment } = await files.store({
    attribution,
    organizationId: ORG,
    uploaderId: 'user-1',
    filename: 'report.pdf',
    mime: 'application/pdf',
    body: Readable.from(Buffer.from('%PDF-1.4 pretend document')),
  })
  assert.equal(storage.blobs.size, 1)

  // What the `attachment.thumbnail` worker job reports back.
  const preview = { data: Buffer.alloc(40, 7), width: 320, height: 200, mime: 'image/webp' }
  assert.equal(
    await files.setThumbnail({
      attachmentId: attachment.id,
      attribution,
      organizationId: ORG,
      thumbnail: preview,
    }),
    true,
  )

  assert.equal(storage.blobs.size, 2)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '65')
  const opened = await files.openThumbnailStream(attachment.id, ORG)
  assert.ok(opened)
  assert.equal(opened.attachment.mime, 'image/webp')
  assert.equal(opened.attachment.sizeBytes, 40n)

  // A re-run must not write a second object or double-count its bytes.
  assert.equal(
    await files.setThumbnail({
      attachmentId: attachment.id,
      attribution,
      organizationId: ORG,
      thumbnail: preview,
    }),
    true,
  )
  assert.equal(storage.blobs.size, 2)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '65')

  // Deleting the attachment must free BOTH objects — a leaked thumbnail is
  // storage nothing accounts for and nothing can ever reach.
  assert.equal(await files.delete(attachment.id, ORG, attribution), true)
  assert.equal(storage.blobs.size, 0)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '0')
})

test('a file with no possible preview is recorded as unavailable, not retried forever', async () => {
  const prisma = makePrisma()
  const storage = makeStorage()
  const files = createFileService({ prisma, storage, maxUploadBytes: 1_000_000 })

  const { attachment } = await files.store({
    attribution,
    organizationId: ORG,
    uploaderId: 'user-1',
    filename: 'archive.zip',
    mime: 'application/zip',
    body: Readable.from(Buffer.from('PK...')),
  })
  assert.equal(
    await files.setThumbnail({
      attachmentId: attachment.id,
      attribution,
      organizationId: ORG,
      thumbnail: null,
    }),
    true,
  )
  assert.equal(storage.blobs.size, 1)
  assert.equal(await files.openThumbnailStream(attachment.id, ORG), null)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '5')
})

test('uploads over the org storage quota are rejected and leave no residue', async () => {
  const prisma = makePrisma([
    { scopeType: 'organization', scopeId: ORG, storageLimitBytes: 10n },
  ])
  const storage = makeStorage()
  const files = createFileService({ prisma, storage, maxUploadBytes: 1_000_000 })

  // First 6 bytes fit under the 10-byte cap.
  await files.store({
    attribution,
    organizationId: ORG,
    uploaderId: 'user-1',
    filename: 'a.bin',
    mime: 'application/octet-stream',
    body: Readable.from(Buffer.from('aaaaaa')),
  })
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '6')

  // Another 6 bytes would total 12 > 10 → rejected after the write, with cleanup.
  await assert.rejects(
    files.store({
      attribution,
      organizationId: ORG,
      uploaderId: 'user-1',
      filename: 'b.bin',
      mime: 'application/octet-stream',
      body: Readable.from(Buffer.from('bbbbbb')),
    }),
    QuotaExceededError,
  )

  assert.equal(storage.blobs.size, 1)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '6')
})
