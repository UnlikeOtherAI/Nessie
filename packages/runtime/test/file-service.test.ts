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
          ...data,
        }
        attachments.set(row.id as string, row)
        return row
      },
      findUnique: async ({ where }: { where: { id: string } }) => attachments.get(where.id) ?? null,
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
  assert.equal(storage.blobs.size, 1)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '11')

  const deleted = await files.delete(attachment.id, ORG, attribution)
  assert.equal(deleted, true)
  assert.equal(storage.blobs.size, 0)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '0')
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
