import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  SPREADSHEET_ENGINE_VERSION,
  SPREADSHEET_LIMITS,
  SpreadsheetAppliedBatchSchema,
  type SpreadsheetBatchSummary,
} from '@nessie/schemas'

import {
  applySpreadsheetBatch,
  createEmptyWorkbook,
  createSpreadsheetPage,
  createSpreadsheetSnapshot,
  completeSpreadsheetImport,
  describeDestructiveOperation,
  listSpreadsheetBatches,
  readSpreadsheetRange,
  spreadsheetClientOpId,
  restoreSpreadsheetVersion,
  restructureSpreadsheet,
  SPREADSHEET_ICALC_MIME,
  SPREADSHEET_XLSX_MIME,
} from '../src/spreadsheet/index.js'
import { parseA1Range } from '@nessie/schemas'
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

const cellSummary = (cells = 1): SpreadsheetBatchSummary => ({
  structuralKind: null,
  sheetIndexes: [0],
  cellCount: cells,
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

const newPage = (seed: SpreadsheetSeed, service: TestService, title: string) =>
  createSpreadsheetPage(service, {
    organizationId: seed.organizationId,
    spaceId: seed.spaceId,
    projectId: seed.projectId,
    title,
    authorId: seed.userId,
    authorType: 'user',
    createdBy: seed.userId,
  })

const write = (
  service: TestService,
  seed: SpreadsheetSeed,
  pageId: string,
  client: ReturnType<typeof createEmptyWorkbook>,
  baseSeq: number,
  edit: () => void,
  summary: SpreadsheetBatchSummary = cellSummary(),
  actor = userActor(seed),
) =>
  applySpreadsheetBatch(
    service,
    {
      organizationId: seed.organizationId,
      pageId,
      clientOpId: randomUUID(),
      actor,
      attribution: attributionFor(seed),
      source: { kind: 'client', diffs: diffsFor(client, edit), baseSeq },
    },
    summary,
  )

test('a destructive operation is recognised from the summary alone', () => {
  assert.equal(
    describeDestructiveOperation({
      structuralKind: 'deleteSheet',
      sheetIndexes: [0],
      cellCount: 0,
      touched: [],
    }),
    'deleteSheet',
  )
  assert.equal(
    describeDestructiveOperation({
      structuralKind: null,
      sheetIndexes: [0],
      cellCount: SPREADSHEET_LIMITS.destructiveCellsThreshold,
      touched: [],
    }),
    `change to ${SPREADSHEET_LIMITS.destructiveCellsThreshold} cells`,
  )
  assert.equal(
    describeDestructiveOperation({
      structuralKind: null,
      sheetIndexes: [0],
      cellCount: 1,
      touched: [],
    }),
    null,
    'an ordinary cell edit is not destructive and must not cost an xlsx write',
  )
})

dbTest('a named version carries the xlsx, the engine bytes and the text projection', async () => {
  const seed = await seedSpreadsheetFixture('sheet-version')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Quarterly')
    const client = createEmptyWorkbook('Sheet1')
    await write(service, seed, page.id, client, 0, () => {
      client.model.setUserInput(0, 1, 1, 'Region')
      client.model.setUserInput(0, 1, 2, 'Revenue')
      client.model.setUserInput(0, 2, 1, 'North')
      client.model.setUserInput(0, 2, 2, '120')
    }, cellSummary(4))

    const snapshot = await createSpreadsheetSnapshot(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      reason: 'named',
      changeComment: 'named: before the rewrite',
    })

    const version = await seed.prisma.knowledgePageVersion.findUniqueOrThrow({
      where: { id: snapshot.versionId },
    })
    const xlsx = await seed.prisma.attachment.findUniqueOrThrow({
      where: { id: version.attachmentId as string },
    })
    assert.equal(xlsx.mime, SPREADSHEET_XLSX_MIME)
    assert.equal(version.changeComment, 'named: before the rewrite')
    assert.ok(version.body?.includes('## Sheet1'), 'the body is the text projection')
    assert.ok(version.body?.includes('Region'))
    assert.match(
      version.sourceContentHash ?? '',
      /^[0-9a-f]{64}$/,
      'identity is the canonical projection hash, never a hash of the engine bytes',
    )

    // The engine bytes ride beside it as a page attachment, so a restore of a
    // recent version is a fast load rather than an xlsx re-import.
    const icalc = await seed.prisma.attachment.findFirst({
      where: { knowledgePageId: page.id, mime: SPREADSHEET_ICALC_MIME },
    })
    assert.ok(icalc, 'the .icalc blob is stored beside the page')
    assert.ok(
      icalc.filename.endsWith(`@${snapshot.versionId}.icalc`),
      'keyed by version id: a version row carries no seq for a restore to match on',
    )

    // The head now points at the version, and nothing is pending.
    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(head.snapshotVersionId, snapshot.versionId)
    assert.equal(Number(head.snapshotSeq), 1)
    assert.equal(head.batchesSinceSnapshot, 0)

    // Indexed like any other version: chunks from the projection, no new path.
    const chunks = await seed.prisma.knowledgePageChunk.count({
      where: { versionId: snapshot.versionId },
    })
    assert.ok(chunks > 0, 'the version is chunked by the shared indexing seam')

    assert.ok(
      service.published.some((event) => event.event === 'sheet.snapshot'),
      'every open pane is told a version exists',
    )
  } finally {
    await seed.teardown()
  }
})

dbTest('a version is taken before a destructive operation, without being asked', async () => {
  const seed = await seedSpreadsheetFixture('sheet-version-destructive')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Safety net')
    const client = createEmptyWorkbook('Sheet1')
    await write(service, seed, page.id, client, 0, () => client.model.setUserInput(0, 1, 1, 'keep me'))
    assert.equal(
      await seed.prisma.knowledgePageVersion.count({ where: { pageId: page.id, attachmentId: { not: null } } }),
      0,
      'an ordinary edit takes no version',
    )

    // A workbook must keep at least one sheet, so the fixture gets a second
    // one before the sheet it can afford to lose is deleted.
    await write(service, seed, page.id, client, 1, () => client.model.newSheet(), {
      structuralKind: 'addSheet', sheetIndexes: [1], cellCount: 0, touched: [],
    })
    const destructive = await write(
      service,
      seed,
      page.id,
      client,
      2,
      () => client.model.deleteSheet(1),
      { structuralKind: 'deleteSheet', sheetIndexes: [1], cellCount: 0, touched: [] },
    )
    assert.ok(destructive.safetyNetVersionId, 'a version is taken before a destructive op')
    const version = await seed.prisma.knowledgePageVersion.findUniqueOrThrow({
      where: { id: destructive.safetyNetVersionId as string },
    })
    assert.equal(version.changeComment, 'before: deleteSheet')
  } finally {
    await seed.teardown()
  }
})

dbTest("an agent run's first write takes a version, and its second does not", async () => {
  const seed = await seedSpreadsheetFixture('sheet-version-agent')
  const service = createTestService(seed)
  try {
    const agent = await seed.prisma.agent.create({
      data: { organizationId: seed.organizationId, projectId: seed.projectId, name: 'Analyst' },
    })
    const page = await newPage(seed, service, 'Agent edits')
    const client = createEmptyWorkbook('Sheet1')
    const runId = randomUUID()
    const agentActor = {
      type: 'agent' as const,
      id: agent.id,
      displayName: 'Analyst',
      agentId: agent.id,
      runId,
    }

    const first = await write(
      service, seed, page.id, client, 0,
      () => client.model.setUserInput(0, 1, 1, 'agent wrote this'),
      cellSummary(), agentActor,
    )
    assert.ok(
      first.safetyNetVersionId,
      "a run's whole contribution must be one diff away from undone",
    )
    const version = await seed.prisma.knowledgePageVersion.findUniqueOrThrow({
      where: { id: first.safetyNetVersionId as string },
    })
    assert.equal(version.changeComment, 'before: Analyst started editing')

    const second = await write(
      service, seed, page.id, client, 1,
      () => client.model.setUserInput(0, 2, 1, 'and this'),
      cellSummary(), agentActor,
    )
    assert.equal(second.safetyNetVersionId, null, 'only the first write of a run')
  } finally {
    await seed.teardown()
  }
})

dbTest('restore rebuilds the head, snapshots first, and tells panes to re-bootstrap', async () => {
  const seed = await seedSpreadsheetFixture('sheet-restore')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Restorable')
    const client = createEmptyWorkbook('Sheet1')
    await write(service, seed, page.id, client, 0, () => client.model.setUserInput(0, 1, 1, 'original'))
    const snapshot = await createSpreadsheetSnapshot(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      reason: 'named',
      changeComment: 'named: v1',
    })

    await write(service, seed, page.id, client, 1, () => client.model.setUserInput(0, 1, 1, 'overwritten'))
    const before = await readSpreadsheetRange(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1'),
    })
    assert.equal(before.rows[0]?.[0]?.value, 'overwritten')

    service.published.length = 0
    const restored = await restoreSpreadsheetVersion(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      versionId: snapshot.versionId,
      actor: userActor(seed),
      attribution: attributionFor(seed),
    })

    // A restore is reversible: it takes its own version of what it replaced.
    assert.ok(restored.previousVersionId, 'a restore that cannot be undone is not a safety net')
    const undoPoint = await seed.prisma.knowledgePageVersion.findUniqueOrThrow({
      where: { id: restored.previousVersionId as string },
    })
    assert.match(undoPoint.changeComment ?? '', /^before: restore to v/)

    const after = await readSpreadsheetRange(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1'),
    })
    assert.equal(after.rows[0]?.[0]?.value, 'original')

    const batch = await seed.prisma.spreadsheetOpBatch.findFirstOrThrow({
      where: { pageId: page.id },
      orderBy: { seq: 'desc' },
    })
    assert.equal(batch.structuralKind, 'restore')
    assert.equal(batch.diffs.byteLength, 0, 'a client cannot transform into a restored workbook')

    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(Number(head.hotSnapshotSeq), Number(head.headSeq))

    const announced = service.published.find(
      (event) => event.event === 'sheet.ops'
        && (event.data as { structuralKind?: string }).structuralKind === 'restore',
    )
    assert.ok(announced, 'panes are told to re-bootstrap rather than handed diffs')
  } finally {
    await seed.teardown()
  }
})

dbTest('purging a page removes both the xlsx renditions and the engine blobs', async () => {
  const seed = await seedSpreadsheetFixture('sheet-purge')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Disposable')
    const client = createEmptyWorkbook('Sheet1')
    await write(service, seed, page.id, client, 0, () => client.model.setUserInput(0, 1, 1, 'x'))
    await createSpreadsheetSnapshot(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      reason: 'named',
      changeComment: 'named: only version',
    })

    const before = await seed.prisma.attachment.count({
      where: { organizationId: seed.organizationId },
    })
    assert.ok(before >= 2, 'the xlsx rendition and the .icalc blob both exist')

    await seed.files.purgeKnowledgePageFiles(page.id, seed.organizationId, attributionFor(seed))
    const after = await seed.prisma.attachment.count({
      where: { organizationId: seed.organizationId },
    })
    assert.equal(after, 0, 'both blobs are removed with the page')
  } finally {
    await seed.teardown()
  }
})

dbTest('compaction is enqueued on the cadence and never before it', async () => {
  const seed = await seedSpreadsheetFixture('sheet-compact-cadence')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Cadence')
    const client = createEmptyWorkbook('Sheet1')
    await write(service, seed, page.id, client, 0, () => client.model.setUserInput(0, 1, 1, 'a'))
    assert.deepEqual(service.compactions, [], 'one batch is not a compaction')

    // Cross the threshold without writing 200 batches: the door reads the
    // head's counter, which is the same thing the sweep reads.
    await seed.prisma.spreadsheetHead.update({
      where: { pageId: page.id },
      data: { batchesSinceSnapshot: SPREADSHEET_LIMITS.compactEveryBatches - 1 },
    })
    await write(service, seed, page.id, client, 1, () => client.model.setUserInput(0, 2, 1, 'b'))
    assert.deepEqual(
      service.compactions.map((job) => job.pageId),
      [page.id],
      'crossing the cadence enqueues exactly one compaction',
    )
  } finally {
    await seed.teardown()
  }
})

dbTest('a server-built structural batch reports the summary it actually produced', async () => {
  const seed = await seedSpreadsheetFixture('sheet-server-summary')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Server built')
    const result = await restructureSpreadsheet(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      action: { op: 'axis', action: { kind: 'insertRows', sheet: 0, row: 1, count: 2 } },
    })
    assert.equal(result.batch?.structuralKind, 'insertRows')
    assert.deepEqual(result.batch?.sheetIndexes, [0])

    const row = await seed.prisma.spreadsheetOpBatch.findFirstOrThrow({
      where: { pageId: page.id },
      orderBy: { seq: 'desc' },
    })
    assert.equal(row.structuralKind, 'insertRows')
    assert.equal(Number(row.baseSeq), 0, 'a server batch is built at head, so it cannot be stale')
  } finally {
    await seed.teardown()
  }
})

dbTest('an imported page catches up: its marker batch parses on the wire', async () => {
  // The import writes a marker batch, and a client opening the page afterwards
  // reads it through listSpreadsheetBatches. The wire form requires a uuid
  // clientOpId, so the literal `import:<attachmentId>` this once carried would
  // have been refused by the reader's own schema — after the import succeeded.
  const seed = await seedSpreadsheetFixture('sheet-import-marker')
  const service = createTestService(seed)
  try {
    const page = await newPage(seed, service, 'Imported')
    const { attachment } = await seed.files.store({
      organizationId: seed.organizationId,
      uploaderId: seed.userId,
      knowledgePageId: page.id,
      mime: 'text/csv',
      filename: 'rows.csv',
      body: Readable.from([Buffer.from('Region,Q3\nNorth,120\nSouth,80\n')]),
    })

    await completeSpreadsheetImport(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      attachmentId: attachment.id,
      filename: 'rows.csv',
      actor: userActor(seed),
      attribution: attributionFor(seed),
    })

    const row = await seed.prisma.spreadsheetOpBatch.findFirstOrThrow({
      where: { pageId: page.id },
      orderBy: { seq: 'desc' },
    })
    assert.notEqual(
      row.clientOpId,
      `import:${attachment.id}`,
      'the literal form never reaches the journal',
    )

    const caught = await listSpreadsheetBatches(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      afterSeq: 0,
    })
    const batches = Array.isArray(caught) ? caught : caught.batches
    assert.ok(batches.length > 0, 'the page has something to catch up on')
    for (const batch of batches) SpreadsheetAppliedBatchSchema.parse(batch)
  } finally {
    await seed.teardown()
  }
})
