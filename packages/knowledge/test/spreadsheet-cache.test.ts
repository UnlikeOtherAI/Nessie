import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { parseA1Range, type SpreadsheetBatchSummary } from '@nessie/schemas'

import {
  applySpreadsheetBatch,
  createEmptyWorkbook,
  createSpreadsheetModelCache,
  createSpreadsheetPage,
  readSpreadsheetRange,
} from '../src/spreadsheet/index.js'
import {
  attributionFor,
  createTestService,
  dbAvailable,
  seedSpreadsheetFixture,
  userActor,
} from './spreadsheet-support.ts'

const dbTest = dbAvailable ? test : test.skip

const cellSummary = (): SpreadsheetBatchSummary => ({
  structuralKind: null,
  sheetIndexes: [0],
  cellCount: 1,
  touched: [],
})

const diffsFor = (client: ReturnType<typeof createEmptyWorkbook>, edit: () => void): Buffer => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue())
}

/**
 * The cache is a cache, never an authority.
 *
 * Two services over one database stand in for two API replicas. They share no
 * memory — the cache is closure state of `createSpreadsheetService`, which is
 * exactly why this test can exist — so the only thing that can make B agree
 * with A is the journal.
 */
dbTest('a batch applied on one replica is visible to a read on another', async () => {
  const seed = await seedSpreadsheetFixture('sheet-cache')
  const replicaA = createTestService(seed)
  const replicaB = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(replicaA, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Two replicas',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })

    // B reads first, so it holds a cached model at seq 0 — the state this test
    // is about: a stale cache that must not be trusted.
    const before = await readSpreadsheetRange(replicaB, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1'),
    })
    assert.equal(before.rows[0]?.[0]?.value, '')
    assert.equal(replicaB.cache.stats().entries, 1)

    const client = createEmptyWorkbook('Sheet1')
    await applySpreadsheetBatch(
      replicaA,
      {
        organizationId: seed.organizationId,
        pageId: page.id,
        clientOpId: randomUUID(),
        actor: userActor(seed),
        attribution: attributionFor(seed),
        source: {
          kind: 'client',
          diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'written on A')),
          baseSeq: 0,
        },
      },
      cellSummary(),
    )

    const after = await readSpreadsheetRange(replicaB, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1'),
    })
    assert.equal(
      after.rows[0]?.[0]?.value,
      'written on A',
      'B must fast-forward its cached model from the journal before reading',
    )
  } finally {
    await seed.teardown()
  }
})

dbTest('an idle model is evicted, and so is one over the byte budget', async () => {
  const seed = await seedSpreadsheetFixture('sheet-cache-evict')
  let clock = 1_000
  const cache = createSpreadsheetModelCache({
    idleMs: 500,
    maxBytes: 1_024,
    now: () => clock,
  })
  const service = createTestService(seed, { cache })
  try {
    const first = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'First',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    assert.equal(cache.stats().entries, 1)

    // Past the idle window: the next touch of the cache drops it.
    clock += 1_000
    assert.equal(cache.get(first.id), null)
    assert.equal(cache.stats().entries, 0)

    // Over the byte budget: the least recently used entry goes first.
    cache.set('page-a', {
      workbook: createEmptyWorkbook('A'),
      seq: 0,
      engineVersion: '0.8.3',
      bytes: 900,
    })
    cache.set('page-b', {
      workbook: createEmptyWorkbook('B'),
      seq: 0,
      engineVersion: '0.8.3',
      bytes: 900,
    })
    assert.equal(cache.stats().entries, 1)
    assert.equal(cache.get('page-a'), null)
    assert.notEqual(cache.get('page-b'), null)
  } finally {
    await seed.teardown()
  }
})

dbTest('a cached model at a foreign engine version is rebuilt, never reused', async () => {
  const seed = await seedSpreadsheetFixture('sheet-cache-engine')
  const service = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Engine drift',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const client = createEmptyWorkbook('Sheet1')
    await applySpreadsheetBatch(
      service,
      {
        organizationId: seed.organizationId,
        pageId: page.id,
        clientOpId: randomUUID(),
        actor: userActor(seed),
        attribution: attributionFor(seed),
        source: {
          kind: 'client',
          diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'kept')),
          baseSeq: 0,
        },
      },
      cellSummary(),
    )

    // Poison the cache with an entry claiming another engine's bytes.
    service.cache.set(page.id, {
      workbook: createEmptyWorkbook('Wrong'),
      seq: 1,
      engineVersion: '0.0.1-not-ours',
      bytes: 0,
    })

    const read = await readSpreadsheetRange(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1'),
    })
    assert.equal(read.rows[0]?.[0]?.value, 'kept')
  } finally {
    await seed.teardown()
  }
})
