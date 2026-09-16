import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { SPREADSHEET_LIMITS, type SpreadsheetBatchSummary } from '@nessie/schemas'
import { canonicalWorkbook } from '@nessie/spreadsheet'

import {
  applySpreadsheetBatch,
  bootstrapSpreadsheet,
  createEmptyWorkbook,
  createSpreadsheetPage,
  listSpreadsheetBatches,
  loadWorkbook,
  SpreadsheetServiceError,
  type SpreadsheetWorkbook,
} from '../src/spreadsheet/index.js'
import {
  attributionFor,
  createTestService,
  dbAvailable,
  seedSpreadsheetFixture,
  userActor,
  type SpreadsheetSeed,
  type TestService,
} from './spreadsheet-support.ts'

const dbTest = dbAvailable ? test : test.skip

const cellSummary = (sheet = 0, cells = 1): SpreadsheetBatchSummary => ({
  structuralKind: null,
  sheetIndexes: [sheet],
  cellCount: cells,
  touched: [],
})

/** A second `UserModel`, standing in for a browser: it produces real diffs. */
const clientAt = (bootstrapBytes: Buffer): SpreadsheetWorkbook => loadWorkbook(bootstrapBytes)

const diffsFor = (client: SpreadsheetWorkbook, edit: () => void): Buffer => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue())
}

const newPage = async (seed: SpreadsheetSeed, service: TestService) =>
  createSpreadsheetPage(service, {
    organizationId: seed.organizationId,
    spaceId: seed.spaceId,
    projectId: seed.projectId,
    title: 'Numbers',
    authorId: seed.userId,
    authorType: 'user',
    createdBy: seed.userId,
  })

const send = (
  service: TestService,
  seed: SpreadsheetSeed,
  pageId: string,
  diffs: Buffer,
  baseSeq: number,
  summary: SpreadsheetBatchSummary = cellSummary(),
) =>
  applySpreadsheetBatch(
    service,
    {
      organizationId: seed.organizationId,
      pageId,
      clientOpId: randomUUID(),
      actor: userActor(seed),
      attribution: attributionFor(seed),
      source: { kind: 'client', diffs, baseSeq },
    },
    summary,
  )

dbTest('a browser batch lands, is numbered, and reaches every reader', async () => {
  const seed = await seedSpreadsheetFixture('sheet-apply')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    assert.equal(bootstrap.headSeq, 0)
    assert.equal(bootstrap.batches.length, 0)
    assert.deepEqual(bootstrap.sheets.map((sheet) => sheet.name), ['Sheet1'])

    const client = clientAt(Buffer.from(bootstrap.snapshot.bytes, 'base64'))
    const first = await send(
      service,
      seed,
      page.id,
      diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'hello')),
      0,
    )
    assert.equal(first.noop, false)
    assert.equal(first.batch?.seq, 1)
    assert.equal(first.headSeq, 1)

    const second = await send(
      service,
      seed,
      page.id,
      diffsFor(client, () => client.model.setUserInput(0, 2, 1, '=1+1')),
      1,
    )
    assert.equal(second.batch?.seq, 2)

    // The page's own revision moves with the journal, so every list that reads
    // `revision` sees a spreadsheet change like any other page edit.
    const row = await seed.prisma.knowledgePage.findUniqueOrThrow({
      where: { id: page.id },
      select: { revision: true },
    })
    assert.equal(row.revision, 2)

    // The batch reached the lane exactly once per applied batch.
    assert.deepEqual(
      service.published.filter((event) => event.event === 'sheet.ops').length,
      2,
    )

    // A fresh reader rebuilds the same workbook from the snapshot plus journal.
    const reader = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: false, actor: userActor(seed) },
    })
    const rebuilt = loadWorkbook(Buffer.from(reader.snapshot.bytes, 'base64'))
    rebuilt.model.pauseEvaluation()
    for (const batch of reader.batches) {
      rebuilt.model.applyExternalDiffs(Buffer.from(batch.diffs as string, 'base64'))
    }
    rebuilt.model.resumeEvaluation()
    rebuilt.model.evaluate()
    assert.equal(rebuilt.model.formattedValue(0, 1, 1), 'hello')
    assert.equal(rebuilt.model.formattedValue(0, 2, 1), '2')
    assert.equal(canonicalWorkbook(rebuilt.model), canonicalWorkbook(client.model))
  } finally {
    await seed.teardown()
  }
})

dbTest('a replayed clientOpId changes nothing and is not broadcast again', async () => {
  const seed = await seedSpreadsheetFixture('sheet-idempotent')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    const client = createEmptyWorkbook('Sheet1')
    const diffs = diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'once'))
    const clientOpId = randomUUID()
    const input = {
      organizationId: seed.organizationId,
      pageId: page.id,
      clientOpId,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      source: { kind: 'client' as const, diffs, baseSeq: 0 },
    }

    const first = await applySpreadsheetBatch(service, input, cellSummary())
    const replay = await applySpreadsheetBatch(service, input, cellSummary())

    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.batch?.seq, first.batch?.seq)
    assert.equal(replay.headSeq, 1)
    assert.equal(
      service.published.filter((event) => event.event === 'sheet.ops').length,
      1,
      'a replay must not reach the lane a second time',
    )
    assert.equal(await seed.prisma.spreadsheetOpBatch.count({ where: { pageId: page.id } }), 1)
  } finally {
    await seed.teardown()
  }
})

dbTest('an empty flush neither journals a batch nor advances the head', async () => {
  const seed = await seedSpreadsheetFixture('sheet-empty-flush')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    // What a drained send queue actually returns: one 0x00 byte, the
    // empty-list encoding — never zero bytes. A client flushing on every
    // microtask sends this constantly.
    const client = createEmptyWorkbook('Sheet1')
    const drained = Buffer.from(client.native.flushSendQueue())
    assert.equal(drained.byteLength, 1)
    assert.equal(drained[0], 0)

    const result = await send(service, seed, page.id, drained, 0)
    assert.equal(result.noop, true)
    assert.equal(result.batch, null)
    assert.equal(result.headSeq, 0)
    assert.equal(await seed.prisma.spreadsheetOpBatch.count({ where: { pageId: page.id } }), 0)
    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(Number(head.headSeq), 0)
    assert.equal(service.published.length, 0)
  } finally {
    await seed.teardown()
  }
})

dbTest('a structural batch refuses a crossing client and hands it the batches since', async () => {
  const seed = await seedSpreadsheetFixture('sheet-conflict')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    const alice = clientAt(Buffer.from(bootstrap.snapshot.bytes, 'base64'))
    const bob = clientAt(Buffer.from(bootstrap.snapshot.bytes, 'base64'))

    // Alice inserts a row: structural, on sheet 0.
    await send(
      service,
      seed,
      page.id,
      diffsFor(alice, () => alice.model.insertRows(0, 1, 1)),
      0,
      {
        structuralKind: 'insertRows',
        sheetIndexes: [0],
        cellCount: 0,
        touched: [],
        intents: [{ kind: 'insertRows', sheet: 0, row: 1, count: 1 }],
      },
    )

    // Bob was still at seq 0 and edits the same sheet.
    const stale = diffsFor(bob, () => bob.model.setUserInput(0, 5, 1, 'bob'))
    await assert.rejects(
      () => send(service, seed, page.id, stale, 0, cellSummary()),
      (error: unknown) => {
        assert.ok(error instanceof SpreadsheetServiceError)
        assert.equal(error.code, 'SPREADSHEET_STRUCTURAL_CONFLICT')
        assert.equal(error.statusCode, 409)
        const details = error.details as { headSeq: number; since: { seq: number }[] }
        assert.equal(details.headSeq, 1)
        assert.deepEqual(details.since.map((batch) => batch.seq), [1])
        return true
      },
    )

    // The replay: Bob applies the foreign batch, re-issues his intent with the
    // row shifted by the insert, and resubmits at the new head.
    bob.model.pauseEvaluation()
    bob.model.applyExternalDiffs(
      Buffer.from(
        (
          await listSpreadsheetBatches(service, {
            organizationId: seed.organizationId,
            pageId: page.id,
            afterSeq: 0,
          })
        ).batches[0]?.diffs as string,
        'base64',
      ),
    )
    bob.model.resumeEvaluation()
    bob.model.evaluate()
    const rebased = diffsFor(bob, () => bob.model.setUserInput(0, 6, 1, 'bob'))
    const accepted = await send(service, seed, page.id, rebased, 1, cellSummary())
    assert.equal(accepted.batch?.seq, 2)
  } finally {
    await seed.teardown()
  }
})

dbTest('a stale but non-structural batch is accepted: last writer by server order wins', async () => {
  const seed = await seedSpreadsheetFixture('sheet-lww')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    const alice = clientAt(Buffer.from(bootstrap.snapshot.bytes, 'base64'))
    const bob = clientAt(Buffer.from(bootstrap.snapshot.bytes, 'base64'))

    await send(service, seed, page.id, diffsFor(alice, () => alice.model.setUserInput(0, 1, 1, 'alice')), 0)
    const late = await send(
      service,
      seed,
      page.id,
      diffsFor(bob, () => bob.model.setUserInput(0, 1, 1, 'bob')),
      0,
    )
    assert.equal(late.batch?.seq, 2)

    const reader = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: false, actor: userActor(seed) },
    })
    const rebuilt = loadWorkbook(Buffer.from(reader.snapshot.bytes, 'base64'))
    rebuilt.model.pauseEvaluation()
    for (const batch of reader.batches) {
      rebuilt.model.applyExternalDiffs(Buffer.from(batch.diffs as string, 'base64'))
    }
    rebuilt.model.resumeEvaluation()
    rebuilt.model.evaluate()
    assert.equal(rebuilt.model.formattedValue(0, 1, 1), 'bob')
  } finally {
    await seed.teardown()
  }
})

dbTest('diffs the engine refuses are a 400, and the cache is dropped', async () => {
  const seed = await seedSpreadsheetFixture('sheet-rejected')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    await assert.rejects(
      () => send(service, seed, page.id, Buffer.from([0xff, 0xff, 0xff, 0xff]), 0),
      (error: unknown) => {
        assert.ok(error instanceof SpreadsheetServiceError)
        assert.equal(error.code, 'SPREADSHEET_BATCH_REJECTED')
        assert.equal(error.statusCode, 400)
        return true
      },
    )
    assert.equal(await seed.prisma.spreadsheetOpBatch.count({ where: { pageId: page.id } }), 0)
    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(Number(head.headSeq), 0)
    assert.equal(service.cache.stats().entries, 0, 'a refused apply must not leave a cached model')
  } finally {
    await seed.teardown()
  }
})

dbTest('the hot snapshot is refreshed on the cadence, bounding a cold replica', async () => {
  const seed = await seedSpreadsheetFixture('sheet-hot-snapshot')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service)
    const client = createEmptyWorkbook('Sheet1')
    const cadence = SPREADSHEET_LIMITS.hotSnapshotEveryBatches
    for (let index = 1; index <= cadence; index++) {
      await send(
        service,
        seed,
        page.id,
        diffsFor(client, () => client.model.setUserInput(0, index, 1, `row ${index}`)),
        index - 1,
      )
      const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
      assert.equal(
        Number(head.hotSnapshotSeq),
        index < cadence ? 0 : cadence,
        `hot snapshot moved at seq ${index}`,
      )
    }

    // A bootstrap after the refresh carries the snapshot and no tail at all.
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    assert.equal(bootstrap.snapshot.seq, cadence)
    assert.equal(bootstrap.batches.length, 0)
    const rebuilt = loadWorkbook(Buffer.from(bootstrap.snapshot.bytes, 'base64'))
    assert.equal(canonicalWorkbook(rebuilt.model), canonicalWorkbook(client.model))
  } finally {
    await seed.teardown()
  }
})
