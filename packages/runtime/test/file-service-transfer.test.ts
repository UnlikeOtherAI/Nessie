import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createFileService, QuotaExceededError } from '../src/files/index.js'
import { FilesystemStorage } from '../src/storage/filesystem.js'

/**
 * `FileService.copy` and `FileService.reassignScope` against real rows.
 *
 * These two exist because `docs/standards/file-storage.md` makes accounting
 * part of the file operation, and both of their invariants are *sums over the
 * ledger*: a copy must add exactly its own bytes in the destination scope, and
 * a move must add nothing at all to the organisation while moving the bytes
 * between two narrower scopes. A cast Prisma fake cannot check either — the
 * sums it would be checking are the fake's own arithmetic — so this suite reads
 * `storage_usage_events` back out of Postgres.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  prisma: PrismaClient
  organizationId: string
  sourceProjectId: string
  targetProjectId: string
  sourceSpaceId: string
  targetSpaceId: string
  userId: string
  storageDir: string
}

const seed = async (): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `xfer-${organizationId}` } })
  await prisma.user.create({
    data: { id: userId, email: `${userId}@transfer.test`, displayName: 'Transfer tester' },
  })
  const [source, target] = await Promise.all([
    prisma.project.create({ data: { organizationId, name: 'Source' } }),
    prisma.project.create({ data: { organizationId, name: 'Target' } }),
  ])
  const space = (name: string, projectId: string) => prisma.knowledgeSpace.create({
    data: { organizationId, projectId, name, createdBy: userId, visibility: 'project' },
    select: { id: true },
  })
  const [sourceSpace, targetSpace] = await Promise.all([
    space('Source docs', source.id),
    space('Target docs', target.id),
  ])
  return {
    prisma,
    organizationId,
    sourceProjectId: source.id,
    targetProjectId: target.id,
    sourceSpaceId: sourceSpace.id,
    targetSpaceId: targetSpace.id,
    userId,
    storageDir: await mkdtemp(join(tmpdir(), 'nessie-xfer-')),
  }
}

const teardown = async (seeded: Seed): Promise<void> => {
  await seeded.prisma.organization.delete({ where: { id: seeded.organizationId } })
  await seeded.prisma.user.delete({ where: { id: seeded.userId } })
  await seeded.prisma.$disconnect()
  await rm(seeded.storageDir, { force: true, recursive: true })
}

const serviceFor = (seeded: Seed) => createFileService({
  prisma: seeded.prisma,
  storage: new FilesystemStorage(seeded.storageDir),
  maxUploadBytes: 10 * 1024 * 1024,
})

const attributionFor = (seeded: Seed) => ({
  organizationId: seeded.organizationId,
  actorId: seeded.userId,
  actorType: 'user' as const,
  userId: seeded.userId,
})

const usageForSpace = async (seeded: Seed, spaceId: string): Promise<bigint> => {
  const sum = await seeded.prisma.storageUsageEvent.aggregate({
    _sum: { deltaBytes: true },
    where: { organizationId: seeded.organizationId, spaceId },
  })
  return sum._sum.deltaBytes ?? 0n
}

const usageForOrganization = async (seeded: Seed): Promise<bigint> => {
  const sum = await seeded.prisma.storageUsageEvent.aggregate({
    _sum: { deltaBytes: true },
    where: { organizationId: seeded.organizationId },
  })
  return sum._sum.deltaBytes ?? 0n
}

dbTest('reassignScope re-homes bytes without changing the organisation total', async () => {
  const seeded = await seed()
  try {
    const files = serviceFor(seeded)
    const bytes = Buffer.from('lease terms, at length'.repeat(8))
    const stored = await files.store({
      attribution: attributionFor(seeded),
      organizationId: seeded.organizationId,
      uploaderId: seeded.userId,
      filename: 'lease.pdf',
      mime: 'application/pdf',
      body: Readable.from(bytes),
      scope: {
        projectId: seeded.sourceProjectId,
        teamId: null,
        spaceId: seeded.sourceSpaceId,
      },
    })

    const organizationBefore = await usageForOrganization(seeded)
    const sourceBefore = await usageForSpace(seeded, seeded.sourceSpaceId)
    assert.equal(sourceBefore, BigInt(stored.bytesWritten))
    assert.equal(await usageForSpace(seeded, seeded.targetSpaceId), 0n)

    const moved = await files.reassignScope([stored.attachment.id], {
      organizationId: seeded.organizationId,
      from: {
        projectId: seeded.sourceProjectId,
        teamId: null,
        spaceId: seeded.sourceSpaceId,
      },
      to: {
        projectId: seeded.targetProjectId,
        teamId: null,
        spaceId: seeded.targetSpaceId,
      },
      attribution: attributionFor(seeded),
    })
    assert.equal(moved.attachmentsMoved, 1)
    assert.equal(moved.bytesMoved, BigInt(stored.bytesWritten))

    // The whole point: the two narrower scopes changed by equal and opposite
    // amounts and the organisation did not move at all, which is why a move
    // runs no quota check.
    assert.equal(await usageForSpace(seeded, seeded.sourceSpaceId), 0n)
    assert.equal(await usageForSpace(seeded, seeded.targetSpaceId), BigInt(stored.bytesWritten))
    assert.equal(await usageForOrganization(seeded), organizationBefore)

    const events = await seeded.prisma.storageUsageEvent.findMany({
      where: { attachmentId: stored.attachment.id, operation: { in: ['move.out', 'move.in'] } },
      select: { operation: true, deltaBytes: true, spaceId: true, projectId: true },
      orderBy: { operation: 'asc' },
    })
    assert.equal(events.length, 2)
    const out = events.find((row) => row.operation === 'move.out')
    const into = events.find((row) => row.operation === 'move.in')
    assert.equal(out?.spaceId, seeded.sourceSpaceId)
    assert.equal(out?.projectId, seeded.sourceProjectId)
    assert.equal(out?.deltaBytes, -BigInt(stored.bytesWritten))
    assert.equal(into?.spaceId, seeded.targetSpaceId)
    assert.equal(into?.projectId, seeded.targetProjectId)
    assert.equal(into?.deltaBytes, BigInt(stored.bytesWritten))

    // Bytes did not move; only their accounted scope did.
    const row = await seeded.prisma.attachment.findUnique({ where: { id: stored.attachment.id } })
    assert.equal(row?.storageKey, stored.attachment.storageKey)
  } finally {
    await teardown(seeded)
  }
})

dbTest('copy re-stores the bytes into a new attachment and charges the destination', async () => {
  const seeded = await seed()
  try {
    const files = serviceFor(seeded)
    const bytes = Buffer.from('a document worth copying')
    const source = await files.store({
      attribution: attributionFor(seeded),
      organizationId: seeded.organizationId,
      uploaderId: seeded.userId,
      filename: 'plan.md',
      mime: 'text/markdown',
      body: Readable.from(bytes),
      scope: {
        projectId: seeded.sourceProjectId,
        teamId: null,
        spaceId: seeded.sourceSpaceId,
      },
    })

    const copied = await files.copy(source.attachment.id, {
      organizationId: seeded.organizationId,
      uploaderId: seeded.userId,
      scope: {
        projectId: seeded.targetProjectId,
        teamId: null,
        spaceId: seeded.targetSpaceId,
      },
      knowledgePageId: null,
      attribution: attributionFor(seeded),
    })
    assert.ok(copied)
    // Never a second pointer at the same object: a purge on either page would
    // otherwise delete bytes the other still shows.
    assert.notEqual(copied.attachment.id, source.attachment.id)
    assert.notEqual(copied.attachment.storageKey, source.attachment.storageKey)
    assert.equal(copied.attachment.filename, 'plan.md')
    assert.equal(copied.attachment.sizeBytes, source.attachment.sizeBytes)

    const roundTripped = await files.openStream(copied.attachment.id, seeded.organizationId)
    assert.ok(roundTripped)
    const chunks: Buffer[] = []
    for await (const chunk of roundTripped.stream) chunks.push(Buffer.from(chunk as Uint8Array))
    assert.equal(Buffer.concat(chunks).toString(), bytes.toString())

    assert.equal(await usageForSpace(seeded, seeded.sourceSpaceId), BigInt(source.bytesWritten))
    assert.equal(await usageForSpace(seeded, seeded.targetSpaceId), BigInt(source.bytesWritten))
    const storeEvents = await seeded.prisma.storageUsageEvent.count({
      where: { attachmentId: copied.attachment.id, operation: 'store' },
    })
    assert.equal(storeEvents, 1)
  } finally {
    await teardown(seeded)
  }
})

dbTest('copy refuses over quota and stores nothing', async () => {
  const seeded = await seed()
  try {
    const files = serviceFor(seeded)
    const bytes = Buffer.from('x'.repeat(4096))
    const source = await files.store({
      attribution: attributionFor(seeded),
      organizationId: seeded.organizationId,
      uploaderId: seeded.userId,
      filename: 'big.bin',
      mime: 'application/octet-stream',
      body: Readable.from(bytes),
      scope: { projectId: seeded.sourceProjectId, teamId: null, spaceId: seeded.sourceSpaceId },
    })

    // Just above what is already stored, so the copy cannot fit.
    await seeded.prisma.budget.create({
      data: {
        organizationId: seeded.organizationId,
        scopeType: 'organization',
        scopeId: seeded.organizationId,
        storageLimitBytes: BigInt(bytes.length + 16),
      },
    })

    const attachmentsBefore = await seeded.prisma.attachment.count({
      where: { organizationId: seeded.organizationId },
    })
    await assert.rejects(
      () => files.copy(source.attachment.id, {
        organizationId: seeded.organizationId,
        uploaderId: seeded.userId,
        scope: { projectId: seeded.targetProjectId, teamId: null, spaceId: seeded.targetSpaceId },
        attribution: attributionFor(seeded),
      }),
      QuotaExceededError,
    )
    // No half-copy: no row, and nothing charged to the destination.
    assert.equal(
      await seeded.prisma.attachment.count({ where: { organizationId: seeded.organizationId } }),
      attachmentsBefore,
    )
    assert.equal(await usageForSpace(seeded, seeded.targetSpaceId), 0n)
  } finally {
    await teardown(seeded)
  }
})

dbTest('copy refuses an attachment belonging to another organisation', async () => {
  const seeded = await seed()
  try {
    const files = serviceFor(seeded)
    const stored = await files.store({
      attribution: attributionFor(seeded),
      organizationId: seeded.organizationId,
      uploaderId: seeded.userId,
      filename: 'private.txt',
      mime: 'text/plain',
      body: Readable.from(Buffer.from('not yours')),
      scope: { projectId: seeded.sourceProjectId, teamId: null, spaceId: seeded.sourceSpaceId },
    })
    const copied = await files.copy(stored.attachment.id, {
      organizationId: randomUUID(),
      uploaderId: null,
      scope: {},
      attribution: { ...attributionFor(seeded), organizationId: randomUUID() },
    })
    assert.equal(copied, null)
  } finally {
    await teardown(seeded)
  }
})
