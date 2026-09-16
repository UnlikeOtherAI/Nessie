import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { SpreadsheetBatchSummary } from '@nessie/schemas'
import { canonicalWorkbook } from '@nessie/spreadsheet'

import {
  applySpreadsheetBatch,
  bootstrapSpreadsheet,
  createSpreadsheetPage,
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
} from './spreadsheet-support.ts'

const dbTest = dbAvailable ? test : test.skip

const BATCHES_PER_CLIENT = 200

const cellSummary = (): SpreadsheetBatchSummary => ({
  structuralKind: null,
  sheetIndexes: [0],
  cellCount: 1,
  touched: [],
})

const diffsFor = (client: SpreadsheetWorkbook, edit: () => void): Buffer => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue())
}

/**
 * The convergence proof.
 *
 * Every assertion here goes through `canonicalWorkbook`, never through bytes:
 * `toBytes()` is not byte-deterministic — two models built by the same binding
 * with the same calls in the same order serialise differently, because a hash
 * map's iteration order reaches the wire (decisions.md §"Spike A"). Comparing
 * bytes would have made this test either flaky or vacuous.
 */
dbTest('400 interleaved batches produce a gapless order and one workbook', async () => {
  const seed = await seedSpreadsheetFixture('sheet-concurrency')
  const service = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Contention',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    const snapshot = Buffer.from(bootstrap.snapshot.bytes, 'base64')

    // Two simulated panes, each submitting its 200 batches **in order**, the
    // two chains raced against each other. That is what a pair of open panes
    // actually does, and it is what the interleaving here has to model: a
    // browser flushes one batch, waits for its ack, flushes the next.
    //
    // Firing all 400 at once instead would prove nothing about ordering and
    // everything about Prisma's connection pool — 400 simultaneous interactive
    // transactions want 400 connections, and the pool holds 21. The burst that
    // *is* worth asserting is the one below, sized to fit.
    const chain = async (column: number) => {
      const client = loadWorkbook(snapshot)
      const seqs: number[] = []
      for (let row = 1; row <= BATCHES_PER_CLIENT; row++) {
        const result = await applySpreadsheetBatch(
          service,
          {
            organizationId: seed.organizationId,
            pageId: page.id,
            clientOpId: randomUUID(),
            actor: userActor(seed),
            attribution: attributionFor(seed),
            // Deliberately stale after the first: none of these is structural,
            // so staleness is not a conflict — the server's order is the order.
            source: {
              kind: 'client',
              diffs: diffsFor(client, () => client.model.setUserInput(0, row, column, `c${column}r${row}`)),
              baseSeq: 0,
            },
          },
          cellSummary(),
        )
        seqs.push(result.batch?.seq ?? 0)
      }
      return seqs
    }

    const results = (await Promise.all([chain(1), chain(2)])).flat()

    const seqs = [...results].sort((a, b) => a - b)
    assert.equal(seqs.length, BATCHES_PER_CLIENT * 2)
    assert.deepEqual(
      seqs,
      Array.from({ length: BATCHES_PER_CLIENT * 2 }, (_, index) => index + 1),
      'seq must be 1..400 with no gaps and no duplicates',
    )
    // And the two chains really did interleave rather than run one after the
    // other, which is the only thing that makes the assertion above mean
    // anything: each pane's own seqs are ascending but not contiguous.
    const firstPane = results.slice(0, BATCHES_PER_CLIENT)
    assert.ok(
      firstPane.some((seq, index) => index > 0 && seq !== (firstPane[index - 1] as number) + 1),
      'the two panes were serialised, so this proved nothing about ordering',
    )

    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(Number(head.headSeq), BATCHES_PER_CLIENT * 2)

    // Replica A: the hot snapshot plus the journal after it — the fast path.
    const rows = await seed.prisma.spreadsheetOpBatch.findMany({
      where: { pageId: page.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, diffs: true },
    })
    const fromHot = loadWorkbook(head.hotSnapshot)
    fromHot.model.pauseEvaluation()
    for (const row of rows) {
      if (Number(row.seq) > Number(head.hotSnapshotSeq)) fromHot.model.applyExternalDiffs(row.diffs)
    }
    fromHot.model.resumeEvaluation()
    fromHot.model.evaluate()

    // Replica B: the whole journal from zero — the cold path a replica that
    // has never seen the page would take if there were no hot snapshot.
    const fromZero = loadWorkbook(snapshot)
    fromZero.model.pauseEvaluation()
    for (const row of rows) fromZero.model.applyExternalDiffs(row.diffs)
    fromZero.model.resumeEvaluation()
    fromZero.model.evaluate()

    assert.equal(canonicalWorkbook(fromHot.model), canonicalWorkbook(fromZero.model))
    assert.equal(fromHot.model.formattedValue(0, 7, 1), 'c1r7')
    assert.equal(fromHot.model.formattedValue(0, 7, 2), 'c2r7')
    // Every cell both clients wrote is present: nothing was lost to the race.
    for (let row = 1; row <= BATCHES_PER_CLIENT; row++) {
      assert.equal(fromZero.model.formattedValue(0, row, 1), `c1r${row}`)
      assert.equal(fromZero.model.formattedValue(0, row, 2), `c2r${row}`)
    }
  } finally {
    await seed.teardown()
  }
})

/**
 * A genuinely simultaneous burst — every submission in flight at once, all
 * wanting the same page's advisory lock. Sized to what a connection pool
 * holds, because beyond that the only thing under test is the pool.
 */
dbTest('a simultaneous burst serialises behind the page lock rather than failing', async () => {
  const seed = await seedSpreadsheetFixture('sheet-burst')
  const service = createTestService(seed)
  const BURST = 16
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'All at once',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    const snapshot = Buffer.from(bootstrap.snapshot.bytes, 'base64')

    // Every payload is built before anything is submitted, so the submissions
    // really are simultaneous rather than serialised behind the engine calls.
    const payloads = Array.from({ length: BURST }, (_, index) => {
      const client = loadWorkbook(snapshot)
      return diffsFor(client, () => client.model.setUserInput(0, index + 1, 1, `burst ${index + 1}`))
    })

    const results = await Promise.all(
      payloads.map((diffs) =>
        applySpreadsheetBatch(
          service,
          {
            organizationId: seed.organizationId,
            pageId: page.id,
            clientOpId: randomUUID(),
            actor: userActor(seed),
            attribution: attributionFor(seed),
            source: { kind: 'client', diffs, baseSeq: 0 },
          },
          cellSummary(),
        ),
      ),
    )

    assert.deepEqual(
      results.map((result) => result.batch?.seq).sort((a, b) => (a ?? 0) - (b ?? 0)),
      Array.from({ length: BURST }, (_, index) => index + 1),
      'the lock gives every writer a distinct seq; nobody is refused and nobody shares one',
    )
    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(Number(head.headSeq), BURST)
  } finally {
    await seed.teardown()
  }
})

dbTest('a structural batch in the middle refuses exactly the crossing clients', async () => {
  const seed = await seedSpreadsheetFixture('sheet-concurrency-structural')
  const service = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Contention with a shift',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const bootstrap = await bootstrapSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      viewer: { canWrite: true, actor: userActor(seed) },
    })
    const snapshot = Buffer.from(bootstrap.snapshot.bytes, 'base64')
    const writer = loadWorkbook(snapshot)
    const surgeon = loadWorkbook(snapshot)

    const before = diffsFor(writer, () => writer.model.setUserInput(0, 1, 1, 'before'))
    const structural = diffsFor(surgeon, () => surgeon.model.insertRows(0, 1, 3))
    const after = diffsFor(writer, () => writer.model.setUserInput(0, 2, 1, 'after'))

    const send = (diffs: Buffer, baseSeq: number, summary: SpreadsheetBatchSummary) =>
      applySpreadsheetBatch(
        service,
        {
          organizationId: seed.organizationId,
          pageId: page.id,
          clientOpId: randomUUID(),
          actor: userActor(seed),
          attribution: attributionFor(seed),
          source: { kind: 'client', diffs, baseSeq },
        },
        summary,
      )

    await send(before, 0, cellSummary())
    await send(structural, 1, {
      structuralKind: 'insertRows',
      sheetIndexes: [0],
      cellCount: 0,
      touched: [],
      intents: [{ kind: 'insertRows', sheet: 0, row: 1, count: 3 }],
    })

    // The writer is still at seq 1 and touches the same sheet: refused.
    await assert.rejects(
      () => send(after, 1, cellSummary()),
      (error: unknown) =>
        error instanceof SpreadsheetServiceError
        && error.code === 'SPREADSHEET_STRUCTURAL_CONFLICT',
    )

    // A client on a *different* sheet crosses nothing and is not refused.
    const other = loadWorkbook(snapshot)
    other.model.newSheet()
    other.native.flushSendQueue()
    const elsewhere = diffsFor(other, () => other.model.setUserInput(0, 9, 9, 'untouched'))
    const accepted = await send(elsewhere, 1, {
      structuralKind: null,
      sheetIndexes: [1],
      cellCount: 1,
      touched: [],
    })
    assert.equal(accepted.batch?.seq, 3)
  } finally {
    await seed.teardown()
  }
})
