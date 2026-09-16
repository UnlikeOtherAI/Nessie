import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { SpreadsheetBatchSummary, SpreadsheetFilterModel } from '@nessie/schemas'

import {
  applySpreadsheetBatch,
  clearSpreadsheetFilter,
  createEmptyWorkbook,
  createSpreadsheetPage,
  getSpreadsheetFilters,
  loadHead,
  modelAtHead,
  reapplySpreadsheetFilter,
  remapFiltersForBatch,
  restructureSpreadsheet,
  setSpreadsheetFilter,
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

const ROWS = [
  ['Region', 'Revenue'],
  ['North', '120'],
  ['South', '80'],
  ['East', '150'],
  ['West', '60'],
]

const seedSheet = async (seed: SpreadsheetSeed, service: TestService) => {
  const page = await createSpreadsheetPage(service, {
    organizationId: seed.organizationId,
    spaceId: seed.spaceId,
    projectId: seed.projectId,
    title: 'Filtered',
    authorId: seed.userId,
    authorType: 'user',
    createdBy: seed.userId,
  })
  const client = createEmptyWorkbook('Sheet1')
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  ROWS.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      client.model.setUserInput(0, rowIndex + 1, columnIndex + 1, value)
    })
  })
  client.model.resumeEvaluation()
  client.model.evaluate()
  await applySpreadsheetBatch(
    service,
    {
      organizationId: seed.organizationId,
      pageId: page.id,
      clientOpId: randomUUID(),
      actor: userActor(seed),
      attribution: attributionFor(seed),
      source: { kind: 'client', diffs: Buffer.from(client.native.flushSendQueue()), baseSeq: 0 },
    },
    { structuralKind: null, sheetIndexes: [0], cellCount: 10, touched: [] },
  )
  return page
}

const who = (seed: SpreadsheetSeed) => ({
  actor: userActor(seed),
  attribution: attributionFor(seed),
})

const revenueOver = (threshold: number): SpreadsheetFilterModel => ({
  range: { r0: 1, c0: 1, r1: 5, c1: 2 },
  columns: { '2': { kind: 'condition', op: 'gt', value: threshold } },
  hiddenRows: [],
  appliedAtSeq: '0',
})

const hiddenRowsOf = async (
  service: TestService,
  seed: SpreadsheetSeed,
  pageId: string,
): Promise<number[]> => {
  const head = await loadHead(seed.prisma as never, seed.organizationId, pageId)
  const workbook = await modelAtHead(service, seed.prisma as never, head)
  const hidden: number[] = []
  for (let row = 1; row <= 5; row++) if (workbook.model.isRowHidden(0, row)) hidden.push(row)
  return hidden
}

dbTest('setting a filter hides exactly the rows that fail it', async () => {
  const seed = await seedSpreadsheetFixture('sheet-filter-set')
  const service = createTestService(seed)
  try {
    const page = await seedSheet(seed, service)
    const result = await setSpreadsheetFilter(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
      model: revenueOver(100),
    })

    // South (80) and West (60) fail; the header row is never filtered out.
    assert.deepEqual(result.hidden, [3, 5])
    assert.deepEqual(await hiddenRowsOf(service, seed, page.id), [3, 5])
    assert.deepEqual(result.filters['0']?.hiddenRows, [3, 5])
    assert.ok(result.batch?.batch, 'applying a filter lands as an ordinary journal batch')
    assert.equal(result.batch?.batch?.structuralKind, null, 'hiding a row moves nothing')
  } finally {
    await seed.teardown()
  }
})

dbTest('clearing unhides only what the filter hid, never a manual hide', async () => {
  const seed = await seedSpreadsheetFixture('sheet-filter-clear')
  const service = createTestService(seed)
  try {
    const page = await seedSheet(seed, service)

    // Somebody hides row 2 by hand, outside any filter.
    await restructureSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      action: {
        op: 'axis',
        action: { kind: 'setRowsHidden', sheet: 0, start: 2, end: 2, hidden: true },
      },
    })

    await setSpreadsheetFilter(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
      model: revenueOver(100),
    })
    assert.deepEqual(await hiddenRowsOf(service, seed, page.id), [2, 3, 5])

    await clearSpreadsheetFilter(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
    })
    assert.deepEqual(
      await hiddenRowsOf(service, seed, page.id),
      [2],
      "the manual hide survives: the model only ever unhides rows it hid itself",
    )
    assert.deepEqual(await getSpreadsheetFilters(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
    }), {})
  } finally {
    await seed.teardown()
  }
})

dbTest('editing a value does not re-filter until somebody asks', async () => {
  const seed = await seedSpreadsheetFixture('sheet-filter-reapply')
  const service = createTestService(seed)
  try {
    const page = await seedSheet(seed, service)
    await setSpreadsheetFilter(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
      model: revenueOver(100),
    })
    assert.deepEqual(await hiddenRowsOf(service, seed, page.id), [3, 5])

    // South goes from 80 to 200: it now passes, but nothing moves yet.
    await restructureSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      action: { op: 'writeRange', sheet: 0, anchor: { row: 3, column: 2 }, rows: [['200']] },
    })
    assert.deepEqual(
      await hiddenRowsOf(service, seed, page.id),
      [3, 5],
      'a row must not reappear under the cursor — the Excel and Sheets rule',
    )

    const reapplied = await reapplySpreadsheetFilter(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
    })
    assert.deepEqual(reapplied.shown, [3])
    assert.deepEqual(await hiddenRowsOf(service, seed, page.id), [5])
  } finally {
    await seed.teardown()
  }
})

dbTest('a structural batch moves the stored filter with the grid', async () => {
  const seed = await seedSpreadsheetFixture('sheet-filter-remap')
  const service = createTestService(seed)
  try {
    const page = await seedSheet(seed, service)
    await setSpreadsheetFilter(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
      model: revenueOver(100),
    })

    await restructureSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      action: { op: 'axis', action: { kind: 'insertRows', sheet: 0, row: 1, count: 2 } },
    })

    const filters = await getSpreadsheetFilters(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
    })
    assert.deepEqual(
      { r0: filters['0']?.range.r0, r1: filters['0']?.range.r1 },
      { r0: 3, r1: 7 },
      'the whole block moved down by the insert',
    )
    assert.deepEqual(filters['0']?.hiddenRows, [5, 7])
  } finally {
    await seed.teardown()
  }
})

dbTest('a filter whose block no longer exists is dropped with an audit note', async () => {
  const seed = await seedSpreadsheetFixture('sheet-filter-stale')
  const service = createTestService(seed)
  const audited: string[] = []
  const withAudit = Object.assign(service, {
    writeAudit: async (
      _tx: unknown,
      entry: { action: string },
    ) => {
      audited.push(entry.action)
    },
  }) as TestService
  try {
    const page = await seedSheet(seed, withAudit)
    const dropped = await setSpreadsheetFilter(withAudit, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      who: who(seed),
      // A block that starts past the end of the sheet.
      model: { ...revenueOver(100), range: { r0: 900, c0: 1, r1: 950, c1: 2 } },
    })
    assert.equal(dropped.dropped, true)
    assert.deepEqual(await getSpreadsheetFilters(withAudit, {
      organizationId: seed.organizationId,
      pageId: page.id,
    }), {})
    assert.ok(
      audited.includes('kb.spreadsheet.filter_dropped'),
      'a dropped filter is said out loud, not repaired in silence',
    )
  } finally {
    await seed.teardown()
  }
})

test('the head remap is driven by the batch summary, and survives a missing one', () => {
  const filters = {
    '0': {
      range: { r0: 1, c0: 1, r1: 5, c1: 2 },
      columns: { '2': { kind: 'condition' as const, op: 'gt' as const, value: 100 } },
      hiddenRows: [3, 5],
      appliedAtSeq: '1',
    },
  }
  const insert: SpreadsheetBatchSummary = {
    structuralKind: 'insertRows',
    sheetIndexes: [0],
    cellCount: 0,
    touched: [],
    intents: [{ kind: 'insertRows', sheet: 0, row: 1, count: 2 }],
  }
  assert.deepEqual(remapFiltersForBatch(filters, insert)['0']?.range, { r0: 3, c0: 1, r1: 7, c1: 2 })

  // A structural batch whose summary declares no intent: advisory means
  // advisory. The model is left alone rather than guessed at, and the next
  // explicit re-apply rebuilds it.
  const silent: SpreadsheetBatchSummary = {
    structuralKind: 'insertRows',
    sheetIndexes: [0],
    cellCount: 0,
    touched: [],
  }
  assert.deepEqual(remapFiltersForBatch(filters, silent)['0']?.range, { r0: 1, c0: 1, r1: 5, c1: 2 })

  // And a non-structural batch never touches it at all.
  assert.deepEqual(
    remapFiltersForBatch(filters, {
      structuralKind: null,
      sheetIndexes: [0],
      cellCount: 1,
      touched: [],
    })['0']?.range,
    { r0: 1, c0: 1, r1: 5, c1: 2 },
  )
})
