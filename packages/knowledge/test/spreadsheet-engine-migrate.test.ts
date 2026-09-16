import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { SpreadsheetBatchSummary } from '@nessie/schemas'

import {
  applySpreadsheetBatch,
  createEmptyWorkbook,
  createSpreadsheetPage,
  createSpreadsheetSnapshot,
  enableXlsxParsing,
  engineVersion,
  migrateSpreadsheetEngine,
  readSpreadsheetRange,
  SpreadsheetServiceError,
} from '../src/spreadsheet/index.js'
import { parseA1Range } from '@nessie/schemas'
import {
  attributionFor,
  createTestService,
  dbAvailable,
  seedSpreadsheetFixture,
  userActor,
} from './spreadsheet-support.ts'

const dbTest = dbAvailable ? test : test.skip

// This suite parses an xlsx (the migration reads the version's rendition), so
// it grants the capability the API deliberately withholds.
enableXlsxParsing()

const cellSummary = (): SpreadsheetBatchSummary => ({
  structuralKind: null,
  sheetIndexes: [0],
  cellCount: 1,
  touched: [],
})

dbTest('a head at a foreign engine version refuses writes, migrates, then accepts', async () => {
  const seed = await seedSpreadsheetFixture('sheet-engine-migrate')
  const service = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Upgrading',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })

    const client = createEmptyWorkbook('Sheet1')
    const diffsFor = (edit: () => void): Buffer => {
      client.native.flushSendQueue()
      client.model.pauseEvaluation()
      edit()
      client.model.resumeEvaluation()
      client.model.evaluate()
      return Buffer.from(client.native.flushSendQueue())
    }
    const send = (diffs: Buffer, baseSeq: number) =>
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
        cellSummary(),
      )

    await send(diffsFor(() => client.model.setUserInput(0, 1, 1, 'survives the bump')), 0)
    await send(diffsFor(() => client.model.setUserInput(0, 2, 1, '=1+1')), 1)

    // The pre-deploy job the *previous* release runs: producing an xlsx needs
    // the old engine, which is why it cannot happen after the swap.
    await createSpreadsheetSnapshot(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
      reason: 'engine-migrate',
      changeComment: 'before: engine upgrade',
    })

    // The swap: this build's engine cannot read the head's bytes.
    await seed.prisma.spreadsheetHead.update({
      where: { pageId: page.id },
      data: { engineVersion: '0.7.0-previous' },
    })
    service.cache.evict(page.id)

    await assert.rejects(
      () => send(diffsFor(() => client.model.setUserInput(0, 3, 1, 'too late')), 2),
      (error: unknown) => {
        assert.ok(error instanceof SpreadsheetServiceError)
        assert.equal(error.code, 'SPREADSHEET_ENGINE_MISMATCH')
        assert.equal(error.statusCode, 409)
        return true
      },
    )
    // Reads keep working: the pane is read-only, not broken.
    const readOnly = await readSpreadsheetRange(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1'),
    })
    assert.equal(readOnly.rows[0]?.[0]?.value, 'survives the bump')

    const migrated = await migrateSpreadsheetEngine(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
    })
    assert.equal(migrated.migrated, true)
    assert.equal(migrated.fromEngineVersion, '0.7.0-previous')
    assert.equal(migrated.toEngineVersion, engineVersion())

    const head = await seed.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId: page.id } })
    assert.equal(head.engineVersion, engineVersion())
    assert.equal(Number(head.hotSnapshotSeq), Number(head.headSeq))
    assert.equal(
      await seed.prisma.spreadsheetOpBatch.count({
        where: { pageId: page.id, seq: { lt: head.headSeq } },
      }),
      0,
      'batches in the old format are pruned: a catch-up must never hand out bytes nobody can decode',
    )

    // The workbook came through the xlsx: values and formulas both.
    const after = await readSpreadsheetRange(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      sheet: 0,
      range: parseA1Range('A1:A2'),
      withContent: true,
    })
    assert.equal(after.rows[0]?.[0]?.value, 'survives the bump')
    assert.equal(after.rows[1]?.[0]?.value, '2')
    assert.equal(after.rows[1]?.[0]?.content, '=1+1', 'a formula is carried, not its cached value')

    // And the door is open again.
    const accepted = await send(
      diffsFor(() => client.model.setUserInput(0, 4, 1, 'after the bump')),
      Number(head.headSeq),
    )
    assert.equal(accepted.noop, false)
    assert.ok(accepted.batch)
  } finally {
    await seed.teardown()
  }
})

dbTest('a page with no durable version refuses to migrate rather than guess', async () => {
  const seed = await seedSpreadsheetFixture('sheet-engine-migrate-bare')
  const service = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Never saved',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    await seed.prisma.spreadsheetHead.update({
      where: { pageId: page.id },
      data: { engineVersion: '0.7.0-previous' },
    })

    await assert.rejects(
      () =>
        migrateSpreadsheetEngine(service, {
          organizationId: seed.organizationId,
          pageId: page.id,
          actor: userActor(seed),
          attribution: attributionFor(seed),
        }),
      (error: unknown) =>
        error instanceof SpreadsheetServiceError && error.code === 'SPREADSHEET_INVALID_REQUEST',
    )
  } finally {
    await seed.teardown()
  }
})

dbTest('migrating a page already on this engine is a no-op', async () => {
  const seed = await seedSpreadsheetFixture('sheet-engine-migrate-noop')
  const service = createTestService(seed)
  try {
    const page = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Current',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const result = await migrateSpreadsheetEngine(service, {
      organizationId: seed.organizationId,
      pageId: page.id,
      actor: userActor(seed),
      attribution: attributionFor(seed),
    })
    assert.equal(result.migrated, false)
    assert.equal(await seed.prisma.spreadsheetOpBatch.count({ where: { pageId: page.id } }), 0)
  } finally {
    await seed.teardown()
  }
})
