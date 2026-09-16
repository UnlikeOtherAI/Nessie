import assert from 'node:assert/strict'

import { listSpreadsheetBatches } from '@nessie/knowledge'
import { shiftIntents } from '@nessie/spreadsheet'
import type { SpreadsheetAppliedBatch, SpreadsheetBatchSummary, SpreadsheetIntent } from '@nessie/schemas'

import { spreadsheetServiceFor } from '../../src/run/pa-tools/spreadsheet-access.js'
import { executeBuiltinTool } from '../../src/run/tools.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { answerOf, seedSpreadsheetRun, type SpreadsheetFixture } from './spreadsheet-fixture.js'
import { runDatabaseTest } from './support.js'

// The builtin tools against a real database, a real IronCalc model and the real
// write door.
//
// Everything asserted here is something a stub could not have told us: that a
// formula an agent wrote evaluates, that a sort moved a row's formatting and
// kept its formula meaning the same thing, that the read cap refuses rather
// than truncates, that a destructive change took a version first, and that a
// replayed tool call does not apply twice.

const call = async (
  context: BuiltinToolRuntimeContext,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId = `call-${toolName}-${Math.random().toString(16).slice(2)}`,
): Promise<Record<string, unknown>> => {
  const result = await executeBuiltinTool(toolName, args, { ...context, toolCallId })
  assert.equal(result.success, true, `${toolName} failed: ${result.output}`)
  return answerOf(result)
}

const headSeqOf = async (fixture: SpreadsheetFixture, pageId: string): Promise<number> => {
  const head = await fixture.prisma.spreadsheetHead.findUniqueOrThrow({
    where: { pageId },
    select: { headSeq: true },
  })
  return Number(head.headSeq)
}

/**
 * The client's own gate, restated here rather than imported: it lives in the
 * admin bundle (`live/sync-engine.ts` `foreignSummary`) and a worker suite
 * cannot import React code. Keeping the two in step is what the assertions
 * below are for — if the client's rule changes, this one has to change with it.
 */
const foreignSummaryOf = (batch: SpreadsheetAppliedBatch): SpreadsheetBatchSummary | null => {
  if (!batch.structuralKind) {
    return { structuralKind: null, sheetIndexes: batch.sheetIndexes, cellCount: 0, touched: [] }
  }
  if (!batch.structuralIntents || batch.structuralIntents.length === 0) return null
  return {
    structuralKind: batch.structuralKind,
    sheetIndexes: batch.sheetIndexes,
    cellCount: batch.cellCount,
    touched: [],
    intents: batch.structuralIntents,
  }
}

const create = async (fixture: SpreadsheetFixture, title: string): Promise<string> => {
  const created = await call(fixture.context, 'sheet_create', {
    spaceId: fixture.spaceId,
    title,
  })
  assert.ok(typeof created.pageId === 'string', `sheet_create answered ${JSON.stringify(created)}`)
  return created.pageId as string
}

runDatabaseTest('an agent describes, writes, reads back an evaluated formula, and finds it', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-tools')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Quarterly')

  const described = await call(fixture.context, 'sheet_describe', { pageId })
  assert.equal(described.title, 'Quarterly')
  assert.deepEqual(
    (described.sheets as { name: string }[]).map((sheet) => sheet.name),
    ['Sheet1'],
  )

  const written = await call(fixture.context, 'sheet_write_range', {
    pageId,
    sheet: 'Sheet1',
    range: 'A1',
    rows: [
      ['Item', 'Cost'],
      ['Rope', 12],
      ['Net', 30],
      ['Total', '=SUM(B2:B3)'],
    ],
  })
  assert.equal(written.written, 8)
  // The engine that evaluated this is the same one the browser runs, so the
  // value the agent reads back is the value the person sees.
  assert.deepEqual((written.values as string[][])[3], ['Total', '42'])

  const read = await call(fixture.context, 'sheet_read_range', {
    pageId,
    sheet: 'Sheet1',
    range: 'B4',
    values: 'formula',
  })
  assert.deepEqual(read.rows, [['=SUM(B2:B3)']])

  const found = await call(fixture.context, 'sheet_find', { pageId, query: 'Net' })
  assert.deepEqual(
    (found.matches as { cell: string }[]).map((match) => match.cell),
    ['A3'],
  )
})

runDatabaseTest('an unknown sheet is refused with the names that do exist', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-names')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Names')

  const answer = await call(fixture.context, 'sheet_read_range', { pageId, sheet: 'Q3 Forecast' })
  assert.match(String(answer.error), /No sheet named/)
  // Naming the workbook's sheets is the difference between the agent fixing it
  // on the next call and the agent guessing again.
  assert.deepEqual(answer.sheets, ['Sheet1'])
})

runDatabaseTest('a range over the read cap is refused with a split that fits', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-cap')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Wide')

  await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: [Array.from({ length: 20 }, (_, index) => `c${index}`)],
  })
  const answer = await call(fixture.context, 'sheet_read_range', { pageId, range: 'A1:T2000' })
  assert.equal(answer.cells, 40_000)
  assert.equal(answer.cap, 10_000)
  // Refused, never silently truncated: an agent handed the first quarter of a
  // sheet would summarise a quarter and say it had read the sheet.
  assert.match(String(answer.suggestion), /^read 500 rows at a time, starting with A1:T500$/)
})

runDatabaseTest('a sort moves formatting with the row and keeps a formula meaning the same', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-sort')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Sortable')

  await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: [
      ['Name', 'Qty', 'Double'],
      ['Zoe', 3, '=B2*2'],
      ['Ana', 1, '=B3*2'],
    ],
  })
  await call(fixture.context, 'sheet_format_range', {
    pageId,
    range: 'A2:C2',
    style: { bold: true },
  })

  const sorted = await call(fixture.context, 'sheet_structure', {
    pageId,
    action: 'sort',
    range: 'A1:C3',
    sort: { by: ['A'], hasHeader: true },
  })
  assert.equal((sorted.outcome as { noop: boolean }).noop, false)

  const after = await call(fixture.context, 'sheet_read_range', { pageId, range: 'A1:C3' })
  assert.deepEqual((after.rows as string[][])[1], ['Ana', '1', '2'])
  assert.deepEqual((after.rows as string[][])[2], ['Zoe', '3', '6'])

  const formulas = await call(fixture.context, 'sheet_read_range', {
    pageId,
    range: 'C2:C3',
    values: 'formula',
  })
  // Excel/Sheets copy semantics: the relative reference moved with its row.
  assert.deepEqual(formulas.rows, [['=B2*2'], ['=B3*2']])

  const styles = await call(fixture.context, 'sheet_read_range', {
    pageId,
    range: 'A2:A3',
    includeStyles: true,
  })
  const bold = (styles.styles as { bold: boolean }[][]).map((row) => row[0]?.bold)
  assert.deepEqual(bold, [false, true], 'the bold row should have travelled to row 3 with Zoe')
})

runDatabaseTest('a run\'s first write and every destructive one take a version first', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-version')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Deletable')

  const seeded = await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: Array.from({ length: 5 }, (_, index) => [`row ${index}`]),
  })
  // The run's first write to this page, which is a version even though writing
  // five cells is not destructive: it is the state a restore goes back to.
  assert.ok(
    (seeded.outcome as { versionId: string | null }).versionId,
    'an agent run\'s first write to a page should snapshot',
  )

  // A three-row delete is under the hundred-row destructive threshold, so it
  // takes no version of its own — the run-start one above is what a restore
  // goes back to. The threshold exists so an agent working through a sheet does
  // not write an xlsx per trivial edit.
  const small = await call(fixture.context, 'sheet_structure', {
    pageId,
    action: 'deleteRows',
    range: '2:4',
  })
  assert.equal(
    (small.outcome as { versionId: string | null }).versionId,
    null,
    'a small delete should lean on the run-start version rather than take its own',
  )

  const deleted = await call(fixture.context, 'sheet_structure', {
    pageId,
    action: 'deleteRows',
    range: '10:200',
  })
  const versionId = (deleted.outcome as { versionId: string | null }).versionId
  assert.ok(versionId, 'a delete over the threshold should have snapshotted first')

  const listed = await call(fixture.context, 'sheet_versions', { pageId, action: 'list' })
  const versions = listed.versions as { id: string; comment: string | null; author: { type: string } }[]
  const safetyNet = versions.find((version) => version.id === versionId)
  assert.ok(safetyNet)
  // The first write of the run takes its own version too, so the comment names
  // whichever reason fired — both are the same safety net.
  assert.match(String(safetyNet.comment), /^before: /)
  assert.equal(safetyNet.author.type, 'agent')

  const restored = await call(fixture.context, 'sheet_versions', {
    pageId,
    action: 'restore',
    versionId,
  })
  assert.equal(restored.restoredVersionId, versionId)
  // A restore that could not itself be undone would be a destructive operation
  // with no safety net.
  assert.ok(restored.previousVersionId)

  const back = await call(fixture.context, 'sheet_read_range', { pageId, range: 'A1:A5' })
  assert.deepEqual(back.rows, [['row 0'], ['row 4'], [''], [''], ['']])
})

runDatabaseTest('a peer\'s pending edit survives an agent inserting rows above it', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-rebase')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Shared')
  const organizationId = String(fixture.context.channel.organizationId)

  await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: Array.from({ length: 6 }, (_, index) => [`row ${index + 1}`]),
  })
  const baseSeq = await headSeqOf(fixture, pageId)

  // What a person had typed but not yet had acknowledged when the agent moved
  // the grid under them. This is the exact shape the pane records.
  const pending: SpreadsheetIntent = {
    kind: 'setUserInput',
    sheet: 0,
    row: 5,
    column: 2,
    value: 'mine',
  }

  await call(fixture.context, 'sheet_structure', {
    pageId,
    action: 'insertRows',
    range: '2:4',
  })

  const service = spreadsheetServiceFor(fixture.context)
  const { batches } = await listSpreadsheetBatches(service, {
    organizationId,
    pageId,
    afterSeq: baseSeq,
  })
  const structural = batches.find((batch) => batch.structuralKind === 'insertRows')
  assert.ok(structural, 'the insert should be on the journal as a structural batch')

  // Without these the client cannot tell *which* rows moved, reads the batch as
  // unrebasable, and drops the person's edit with a notice.
  assert.deepEqual(structural.structuralIntents, [
    { kind: 'insertRows', sheet: 0, row: 2, count: 3 },
  ])

  const foreign = foreignSummaryOf(structural)
  assert.ok(foreign, 'a structural batch carrying intents can be rebased against')
  const shifted = shiftIntents([pending], [foreign])
  assert.equal(shifted.length, 1, 'the pending edit should survive, not be dropped')
  assert.deepEqual(shifted[0], { ...pending, row: 8 })
})

runDatabaseTest('a sort is honestly unrebasable rather than falsely shiftable', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-rebase-sort')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Sorted')
  const organizationId = String(fixture.context.channel.organizationId)

  await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: [['Zoe'], ['Ana'], ['Mo']],
  })
  const baseSeq = await headSeqOf(fixture, pageId)
  await call(fixture.context, 'sheet_structure', {
    pageId,
    action: 'sort',
    range: 'A1:A3',
    sort: { by: ['A'] },
  })

  const service = spreadsheetServiceFor(fixture.context)
  const { batches } = await listSpreadsheetBatches(service, {
    organizationId,
    pageId,
    afterSeq: baseSeq,
  })
  const sorted = batches.find((batch) => batch.structuralKind === 'sort')
  assert.ok(sorted)
  // A sort reorders rows by content, not by an index delta, so there is no
  // shift that would carry a pending edit correctly. Saying "cannot be
  // rebased" is the honest answer; inventing one would land somebody's edit on
  // whichever row now happens to sit at that index.
  assert.equal(sorted.structuralIntents, undefined)
  assert.equal(foreignSummaryOf(sorted), null)
})

runDatabaseTest('replaying a tool call by its id does not apply the write twice', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-replay')
  t.after(fixture.cleanup)
  const pageId = await create(fixture, 'Idempotent')

  const toolCallId = 'call-replayed-once'
  const first = await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: [['one']],
  }, toolCallId)
  const second = await call(fixture.context, 'sheet_write_range', {
    pageId,
    range: 'A1',
    rows: [['two']],
  }, toolCallId)

  assert.equal(
    (second.outcome as { seq: number }).seq,
    (first.outcome as { seq: number }).seq,
    'a replayed tool call must be answered with the batch that already landed',
  )
  assert.equal((second.outcome as { replayed: boolean }).replayed, true)
  const read = await call(fixture.context, 'sheet_read_range', { pageId, range: 'A1' })
  assert.deepEqual(read.rows, [['one']])
})

runDatabaseTest('an agent is refused a restricted space, and is told why', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-restricted')
  t.after(fixture.cleanup)

  const result = await executeBuiltinTool(
    'sheet_create',
    { spaceId: fixture.restrictedSpaceId, title: 'Payroll model' },
    fixture.context,
  )
  assert.equal(result.success, false)
  assert.match(result.output, /restricted knowledge space/)
})

runDatabaseTest('kb_file names a spreadsheet parent rather than answering "not found"', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-kb-file')
  t.after(fixture.cleanup)

  const pageId = await create(fixture, 'Runway')
  // `kb_draft_write` answers in prose rather than JSON, so the id comes out of
  // the sentence the agent itself reads.
  const drafted = await executeBuiltinTool('kb_draft_write', {
    spaceId: fixture.spaceId,
    title: 'Assumptions',
    body: 'A note about the model.',
  }, fixture.context)
  assert.equal(drafted.success, true, drafted.output)
  const draftPageId = /pageId=([0-9a-f-]{36})/.exec(drafted.output)?.[1]
  assert.ok(draftPageId, `no pageId in: ${drafted.output}`)

  // `movePage` refuses a spreadsheet parent by returning null, which reads as
  // "no such page" — an agent told only "check that the target parent exists"
  // retries the same id forever. Naming the kind is what ends the loop.
  const refused = await executeBuiltinTool(
    'kb_file',
    { pageId: draftPageId, parentPageId: pageId },
    fixture.context,
  )
  assert.equal(refused.success, false)
  assert.match(refused.output, /that is a spreadsheet/)
  assert.match(refused.output, /under a folder or a document/)

  const unmoved = await fixture.prisma.knowledgePage.findUniqueOrThrow({
    where: { id: draftPageId },
    select: { parentPageId: true },
  })
  assert.equal(unmoved.parentPageId, null)

  // A spreadsheet is a leaf, not a container — but it files *into* one exactly
  // as any other page does.
  const folder = await fixture.prisma.knowledgePage.create({
    data: {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      spaceId: fixture.spaceId,
      teamId: fixture.teamId,
      title: 'Models',
      kind: 'folder',
      status: 'published',
      createdBy: fixture.agentId,
    },
  })
  const filed = await executeBuiltinTool(
    'kb_file',
    { pageId: draftPageId, parentPageId: folder.id },
    fixture.context,
  )
  assert.equal(filed.success, true, filed.output)
})
