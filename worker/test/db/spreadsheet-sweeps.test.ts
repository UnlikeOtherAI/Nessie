import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { engineVersion } from '@nessie/knowledge'
import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import {
  SPREADSHEET_ENGINE_MIGRATE_TOPIC,
  pruneSpreadsheetOpBatches,
  spreadsheetEngineMigrateJobKey,
  spreadsheetIdleCompactJobKey,
  sweepIdleSpreadsheets,
  sweepStaleSpreadsheetEngines,
} from '../../src/control/spreadsheet-sweeps.js'
import { SPREADSHEET_COMPACT_TOPIC } from '../../src/control/spreadsheet-compact.js'

/**
 * The three timer-driven sweeps, against real rows.
 *
 * These are deliberately database tests rather than stubs of Prisma: every one
 * of them is a predicate over columns (`batches_since_snapshot`, `last_op_at`,
 * `LEAST(snapshot_seq, hot_snapshot_seq)`, `deleted_at`), and a fake that
 * answers the query cannot tell me the query is right. The rows are seeded
 * directly — the sweeps never load a workbook, so there is no reason to pay
 * for an engine.
 *
 * Each test seeds its own organisation and counts only inside it, so the suite
 * is honest on a database other suites are using at the same time.
 */

const dbAvailable = Boolean(process.env['DATABASE_URL'])

type Seed = {
  prisma: PrismaClient
  organizationId: string
  projectId: string
  spaceId: string
  userId: string
  page: (overrides?: { deletedAt?: Date }) => Promise<string>
  teardown: () => Promise<void>
}

const seedOrg = async (label: string): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `${label}-${organizationId}` } })
  await prisma.user.create({
    data: { id: userId, email: `${userId}@${label}.test`, displayName: 'Sweeper' },
  })
  await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
  const project = await prisma.project.create({ data: { organizationId, name: `${label} project` } })
  const space = await prisma.knowledgeSpace.create({
    data: {
      organizationId,
      projectId: project.id,
      name: `${label} space`,
      visibility: 'project',
      createdBy: userId,
    },
  })

  const pageIds: string[] = []

  return {
    prisma,
    organizationId,
    projectId: project.id,
    spaceId: space.id,
    userId,
    page: async (overrides = {}) => {
      const row = await prisma.knowledgePage.create({
        data: {
          organizationId,
          projectId: project.id,
          spaceId: space.id,
          title: `${label} sheet`,
          kind: 'spreadsheet',
          createdBy: userId,
          ...(overrides.deletedAt ? { deletedAt: overrides.deletedAt } : {}),
        },
      })
      pageIds.push(row.id)
      return row.id
    },
    teardown: async () => {
      // Queue rows are not scoped to an organisation, so they are removed by
      // this seed's own page ids rather than by topic: a `deleteMany` on the
      // topic alone would take a concurrent suite's jobs with it.
      for (const pageId of pageIds) {
        await prisma.queueJob.deleteMany({
          where: {
            topic: { in: [SPREADSHEET_COMPACT_TOPIC, SPREADSHEET_ENGINE_MIGRATE_TOPIC] },
            idempotencyKey: { contains: pageId },
          },
        })
      }
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.$disconnect()
    },
  }
}

type HeadOverrides = {
  headSeq?: number
  hotSnapshotSeq?: number
  snapshotSeq?: number
  snapshotVersionId?: string | null
  batchesSinceSnapshot?: number
  lastOpAt?: Date | null
  engineVersion?: string
}

const seedHead = async (seed: Seed, pageId: string, overrides: HeadOverrides = {}) => {
  await seed.prisma.spreadsheetHead.create({
    data: {
      pageId,
      organizationId: seed.organizationId,
      headSeq: BigInt(overrides.headSeq ?? 0),
      engineVersion: overrides.engineVersion ?? engineVersion(),
      hotSnapshot: Buffer.alloc(0),
      hotSnapshotSeq: BigInt(overrides.hotSnapshotSeq ?? 0),
      snapshotSeq: BigInt(overrides.snapshotSeq ?? 0),
      snapshotVersionId: overrides.snapshotVersionId ?? null,
      batchesSinceSnapshot: overrides.batchesSinceSnapshot ?? 0,
      sheetNames: ['Sheet1'],
      lastOpAt: overrides.lastOpAt === undefined ? new Date() : overrides.lastOpAt,
    },
  })
}

const seedBatch = async (seed: Seed, pageId: string, seq: number, createdAt: Date) => {
  await seed.prisma.spreadsheetOpBatch.create({
    data: {
      pageId,
      organizationId: seed.organizationId,
      seq: BigInt(seq),
      baseSeq: BigInt(seq - 1),
      clientOpId: randomUUID(),
      actorType: 'user',
      actorId: seed.userId,
      engineVersion: engineVersion(),
      diffs: Buffer.alloc(1),
      sheetIndexes: [0],
      cellCount: 1,
      summary: {},
      createdAt,
    },
  })
}

const compactJobsFor = async (seed: Seed, pageId: string) =>
  seed.prisma.queueJob.findMany({
    where: { topic: SPREADSHEET_COMPACT_TOPIC, idempotencyKey: { contains: pageId } },
    select: { idempotencyKey: true },
  })

const IDLE = SPREADSHEET_LIMITS.compactAfterIdleMs
const RETENTION_MS = SPREADSHEET_LIMITS.opsRetentionDays * 24 * 60 * 60 * 1000

test('the idle sweep compacts a page that stopped short of the cadence, once per head', { skip: !dbAvailable }, async () => {
  const seed = await seedOrg('sheet-sweep-idle')
  try {
    const idle = await seed.page()
    // Nineteen batches: a real editing session that would never reach
    // `compactEveryBatches` on its own.
    await seedHead(seed, idle, {
      headSeq: 19,
      batchesSinceSnapshot: 19,
      lastOpAt: new Date(Date.now() - IDLE - 60_000),
    })
    const busy = await seed.page()
    await seedHead(seed, busy, {
      headSeq: 19,
      batchesSinceSnapshot: 19,
      lastOpAt: new Date(),
    })
    const saved = await seed.page()
    await seedHead(seed, saved, {
      headSeq: 19,
      batchesSinceSnapshot: 0,
      lastOpAt: new Date(Date.now() - IDLE - 60_000),
    })
    const gone = await seed.page({ deletedAt: new Date() })
    await seedHead(seed, gone, {
      headSeq: 19,
      batchesSinceSnapshot: 19,
      lastOpAt: new Date(Date.now() - IDLE - 60_000),
    })

    const first = await sweepIdleSpreadsheets(seed.prisma)
    assert.equal(first.failed, 0)
    assert.deepEqual(
      (await compactJobsFor(seed, idle)).map((row) => row.idempotencyKey),
      [spreadsheetIdleCompactJobKey(idle, 19n)],
    )
    // A page still being edited waits; one already captured has nothing to
    // capture; a deleted page's blobs are purged with it.
    assert.deepEqual(await compactJobsFor(seed, busy), [])
    assert.deepEqual(await compactJobsFor(seed, saved), [])
    assert.deepEqual(await compactJobsFor(seed, gone), [])

    // The tick repeats every minute and the head has not moved: the queue's
    // idempotency must collapse it rather than enqueue a compaction a minute
    // for as long as the page stays idle.
    await sweepIdleSpreadsheets(seed.prisma)
    assert.equal((await compactJobsFor(seed, idle)).length, 1)

    // The page is edited again and goes quiet again. This is the case the
    // cadence key gets wrong: `spreadsheetCompactJobKey` floors seq 19 and
    // seq 26 into the same step 0, so the second session would never be
    // captured until batch 200.
    await seed.prisma.spreadsheetHead.update({
      where: { pageId: idle },
      data: { headSeq: 26n, batchesSinceSnapshot: 26 },
    })
    await sweepIdleSpreadsheets(seed.prisma)
    assert.deepEqual(
      (await compactJobsFor(seed, idle)).map((row) => row.idempotencyKey).sort(),
      [spreadsheetIdleCompactJobKey(idle, 19n), spreadsheetIdleCompactJobKey(idle, 26n)].sort(),
    )
  } finally {
    await seed.teardown()
  }
})

test('pruning removes journal batches both snapshots cover, and nothing else', { skip: !dbAvailable }, async () => {
  const seed = await seedOrg('sheet-sweep-prune')
  try {
    const pageId = await seed.page()
    const old = new Date(Date.now() - RETENTION_MS - 60_000)
    const recent = new Date()
    // hot_snapshot_seq 8, snapshot_seq 5 → the floor is 5. Batch 6 is folded
    // into the hot bytes but is the only remaining record of who changed what
    // since the durable version, so it stays.
    await seedHead(seed, pageId, {
      headSeq: 10,
      hotSnapshotSeq: 8,
      snapshotSeq: 5,
      snapshotVersionId: randomUUID(),
    })
    for (const seq of [1, 2, 3, 4, 5, 6, 7, 8]) await seedBatch(seed, pageId, seq, old)
    for (const seq of [9, 10]) await seedBatch(seed, pageId, seq, recent)

    const result = await pruneSpreadsheetOpBatches(seed.prisma)
    assert.equal(result.failed, 0)
    assert.equal(result.deleted, 5)
    assert.deepEqual(
      (
        await seed.prisma.spreadsheetOpBatch.findMany({
          where: { pageId },
          orderBy: { seq: 'asc' },
          select: { seq: true },
        })
      ).map((row) => Number(row.seq)),
      [6, 7, 8, 9, 10],
    )

    // Idempotent: a second tick has nothing left above the floor and older
    // than retention, and must not walk down into batch 6.
    const second = await pruneSpreadsheetOpBatches(seed.prisma)
    assert.equal(second.deleted, 0)
    assert.equal(await seed.prisma.spreadsheetOpBatch.count({ where: { pageId } }), 5)
  } finally {
    await seed.teardown()
  }
})

test('pruning never touches a version — there is no version-retention policy', { skip: !dbAvailable }, async () => {
  const seed = await seedOrg('sheet-sweep-versions')
  try {
    const pageId = await seed.page()
    const old = new Date(Date.now() - RETENTION_MS * 12)
    await seedHead(seed, pageId, { headSeq: 3, hotSnapshotSeq: 3, snapshotSeq: 3 })
    for (const seq of [1, 2, 3]) await seedBatch(seed, pageId, seq, old)
    // Versions a year older than any retention window anybody might imagine.
    for (const versionNumber of [1, 2, 3]) {
      await seed.prisma.knowledgePageVersion.create({
        data: {
          pageId,
          versionNumber,
          body: `v${versionNumber}`,
          authorType: 'user',
          authorId: seed.userId,
          createdAt: old,
        },
      })
    }

    await pruneSpreadsheetOpBatches(seed.prisma)
    assert.equal(await seed.prisma.spreadsheetOpBatch.count({ where: { pageId } }), 0)
    assert.equal(await seed.prisma.knowledgePageVersion.count({ where: { pageId } }), 3)
  } finally {
    await seed.teardown()
  }
})

test('the engine sweep enqueues a rebuild only for a page it can rebuild', { skip: !dbAvailable }, async () => {
  const seed = await seedOrg('sheet-sweep-engine')
  try {
    const stale = await seed.page()
    await seedHead(seed, stale, { engineVersion: '0.0.1-previous', snapshotVersionId: randomUUID() })
    // No durable version: `migrateSpreadsheetEngine` refuses this one, so
    // enqueuing would only burn its attempts. It is the pre-swap snapshot
    // step's failure, not the sweep's.
    const unrebuildable = await seed.page()
    await seedHead(seed, unrebuildable, { engineVersion: '0.0.1-previous' })
    const current = await seed.page()
    await seedHead(seed, current, { snapshotVersionId: randomUUID() })

    const migrateKeysFor = async (pageId: string) =>
      (
        await seed.prisma.queueJob.findMany({
          where: {
            topic: SPREADSHEET_ENGINE_MIGRATE_TOPIC,
            idempotencyKey: { contains: pageId },
          },
          select: { idempotencyKey: true },
        })
      ).map((row) => row.idempotencyKey)

    const result = await sweepStaleSpreadsheetEngines(seed.prisma)
    assert.equal(result.failed, 0)

    assert.deepEqual(await migrateKeysFor(stale), [
      spreadsheetEngineMigrateJobKey(stale, engineVersion()),
    ])
    assert.deepEqual(await migrateKeysFor(unrebuildable), [])
    assert.deepEqual(await migrateKeysFor(current), [])

    // A second tick is the same job.
    await sweepStaleSpreadsheetEngines(seed.prisma)
    assert.equal((await migrateKeysFor(stale)).length, 1)
  } finally {
    await seed.teardown()
  }
})
