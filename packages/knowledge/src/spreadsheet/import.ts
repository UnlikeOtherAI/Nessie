import { Readable } from 'node:stream'

import type { LedgerAttribution } from '@nessie/runtime'
import { SPREADSHEET_LIMITS } from '@nessie/schemas'
import { importCsv } from '@nessie/spreadsheet'
import {
  detectWorkbookFormat,
  scanXlsxWarnings,
  type XlsxImportWarning,
} from '@nessie/spreadsheet/xlsx-warnings'

import { writeSpreadsheetHead } from './create.js'
import {
  createEmptyWorkbook,
  engineVersion,
  importXlsxBytes,
  type SpreadsheetWorkbook,
} from './engine.js'
import { invalidRequest, tooLarge, unsupportedFeature } from './errors.js'
import { lockSpreadsheetPage, loadHead } from './head.js'
import { createSpreadsheetSnapshot } from './snapshot.js'
import { declaredUncompressedBytes } from './zip-size.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'
import type { KnowledgePageRecord } from '../types.js'

/**
 * Import, and converting an uploaded file node into a spreadsheet.
 *
 * **The parse runs on the worker, never on an API request.** `fromXlsx` plus
 * `evaluate()` on a foreign workbook writes one diagnostic line per affected
 * cell to fd 1 from a Rust thread — tens of thousands of them for a small file
 * — and when that write fails the engine panics inside the napi call and the
 * process dies, uncatchably. `engine.ts` makes that a capability the API never
 * grants, so this module's parsing half only runs where it is safe.
 *
 * The caps are the spike's, not the plan's: a 3.27 MB xlsx already needs
 * ~864 MB resident and sheet XML decompresses about 11:1, so the plan's 64 MiB
 * parse cap would admit a workbook needing roughly 15 GB. The binding has no
 * cap of its own, so this is the only place one exists.
 *
 * They live in `SPREADSHEET_LIMITS` (`packages/schemas/src/spreadsheet.ts`)
 * so the admin, the tools and this path refuse the same upload.
 */
export const SPREADSHEET_IMPORT_LIMITS = {
  maxImportBytes: SPREADSHEET_LIMITS.maxImportBytes,
  maxImportUncompressedBytes: SPREADSHEET_LIMITS.maxImportUncompressedBytes,
  maxCsvBytes: SPREADSHEET_LIMITS.maxCsvImportBytes,
} as const

export type { XlsxImportWarning }

/**
 * Everything that can be decided about an upload **without handing it to the
 * engine**: the format, the caps and the loss list. Safe on any process, and
 * what the API route runs before it enqueues the parse.
 */
export const inspectUpload = (
  filename: string,
  bytes: Buffer,
): { format: 'xlsx' | 'csv'; warnings: XlsxImportWarning[] } => {
  const format = detectWorkbookFormat(bytes.subarray(0, 1_024))

  if (format === 'xls') {
    // Refused by name, not by the engine's message: its error for a 1997 file
    // is byte-identical to its error for a corrupt zip, so without sniffing a
    // person who uploaded an old file is told their file is broken.
    throw unsupportedFeature(
      'This is the older .xls format. Open it and save it as .xlsx, then upload that.',
      { filename },
    )
  }

  if (format === 'xlsx') {
    if (bytes.byteLength > SPREADSHEET_IMPORT_LIMITS.maxImportBytes) {
      throw tooLarge('That workbook is too large to import', {
        bytes: bytes.byteLength,
        maxBytes: SPREADSHEET_IMPORT_LIMITS.maxImportBytes,
      })
    }
    const uncompressed = declaredUncompressedBytes(bytes)
    if (uncompressed === null) {
      throw unsupportedFeature('That file could not be read as a workbook', { filename })
    }
    if (uncompressed > SPREADSHEET_IMPORT_LIMITS.maxImportUncompressedBytes) {
      throw tooLarge('That workbook expands to more than this instance will open', {
        uncompressedBytes: uncompressed,
        maxUncompressedBytes: SPREADSHEET_IMPORT_LIMITS.maxImportUncompressedBytes,
      })
    }
    return { format: 'xlsx', warnings: scanXlsxWarnings(bytes) }
  }

  if (format === 'csv-or-text') {
    if (bytes.byteLength > SPREADSHEET_IMPORT_LIMITS.maxCsvBytes) {
      throw tooLarge('That file is too large to import', {
        bytes: bytes.byteLength,
        maxBytes: SPREADSHEET_IMPORT_LIMITS.maxCsvBytes,
      })
    }
    return { format: 'csv', warnings: [] }
  }

  throw unsupportedFeature('That file is not a spreadsheet', { filename })
}

/**
 * The workbook an upload becomes. **Worker only** for an xlsx — `engine.ts`
 * refuses to parse one in a process that has not been granted the capability.
 */
export const workbookFromUpload = (
  filename: string,
  bytes: Buffer,
): { workbook: SpreadsheetWorkbook; warnings: XlsxImportWarning[] } => {
  const { format, warnings } = inspectUpload(filename, bytes)
  if (format === 'xlsx') return { workbook: importXlsxBytes(bytes), warnings }

  const workbook = createEmptyWorkbook('Sheet1')
  // `pasteCsvString` is tab-separated despite its name, so a real CSV is
  // parsed by `@nessie/spreadsheet`'s own reader and handed over as a block.
  const result = importCsv(workbook.model, { csv: bytes.toString('utf8'), sheet: 0 })
  if (result.rowCount === 0) throw invalidRequest('That file has no rows', { filename })
  workbook.model.evaluate()
  return { workbook, warnings }
}

export type ImportSpreadsheetInput = {
  organizationId: string
  spaceId: string
  projectId: string
  title: string
  filename: string
  bytes: Buffer
  parentPageId?: string | null
  taskId?: string | null
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
  createdBy: string
}

export type ImportSpreadsheetResult = {
  page: KnowledgePageRecord
  versionId: string
  warnings: XlsxImportWarning[]
}

/**
 * Create the page, keep the upload beside it, and leave it empty.
 *
 * The API runs this: it decides the format, the caps and the loss list without
 * the engine, then enqueues the parse. The page exists immediately — Rule zero
 * — so it appears in the tree and can be opened while the worker fills it.
 */
export const stageSpreadsheetImport = async (
  deps: SpreadsheetServiceDeps,
  input: ImportSpreadsheetInput,
): Promise<{ page: KnowledgePageRecord; attachmentId: string; warnings: XlsxImportWarning[] }> => {
  const { warnings } = inspectUpload(input.filename, input.bytes)

  const page = await deps.createPage({
    organizationId: input.organizationId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    title: input.title,
    kind: 'spreadsheet',
    authorId: input.actor.id,
    authorType: input.actor.type,
    createdBy: input.createdBy,
    origin: 'import',
    trust: 'unverified_import',
    parentPageId: input.parentPageId ?? null,
    taskId: input.taskId ?? null,
  })

  const workbook = createEmptyWorkbook('Sheet1')
  await deps.prisma.$transaction((tx) =>
    writeSpreadsheetHead(tx, {
      pageId: page.id,
      organizationId: input.organizationId,
      workbook,
    }),
  )

  // The upload itself is kept beside the page, so "what did I actually send?"
  // has an answer no import decision can take away — and so the worker has
  // bytes to read rather than a payload to carry.
  const stored = await deps.fileService.store({
    attribution: input.attribution,
    body: Readable.from([input.bytes]),
    filename: input.filename,
    mime: 'application/octet-stream',
    organizationId: input.organizationId,
    scope: { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId },
    uploaderId: input.actor.type === 'user' ? input.actor.id : null,
    knowledgePageId: page.id,
  })

  return { page, attachmentId: stored.attachment.id, warnings }
}

/**
 * Fill a staged page from its upload. **Worker only.**
 *
 * The workbook replaces the head's hot snapshot and appends a `restore` batch,
 * exactly as a restore does, so any pane already open on the empty page
 * re-bootstraps instead of trying to apply diffs it cannot have.
 */
export const completeSpreadsheetImport = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    attachmentId: string
    filename: string
    actor: SpreadsheetWriteActor
    attribution: LedgerAttribution
  },
): Promise<{ versionId: string; warnings: XlsxImportWarning[] }> => {
  const opened = await deps.fileService.openStream(input.attachmentId, input.organizationId)
  if (!opened) throw invalidRequest('The uploaded file could not be read', { pageId: input.pageId })
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Buffer))

  const { workbook, warnings } = workbookFromUpload(input.filename, Buffer.concat(chunks))
  const bytes = Buffer.from(workbook.model.toBytes())
  const sheetNames = workbook.model.sheets().map((sheet) => sheet.name)

  const seq = await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const next = Number(head.headSeq) + 1
    await tx.spreadsheetOpBatch.create({
      data: {
        pageId: input.pageId,
        organizationId: input.organizationId,
        seq: BigInt(next),
        baseSeq: head.headSeq,
        clientOpId: `import:${input.attachmentId}`,
        actorType: input.actor.type,
        actorId: input.actor.id,
        agentId: input.actor.agentId ?? null,
        engineVersion: engineVersion(),
        diffs: Buffer.alloc(0),
        structuralKind: 'restore',
        sheetIndexes: [],
        cellCount: 0,
        summary: { structuralKind: 'restore', sheetIndexes: [], cellCount: 0, touched: [] },
      },
    })
    await tx.spreadsheetHead.update({
      where: { pageId: input.pageId },
      data: {
        headSeq: BigInt(next),
        hotSnapshot: bytes,
        hotSnapshotSeq: BigInt(next),
        engineVersion: engineVersion(),
        sheetNames,
        batchesSinceSnapshot: { increment: 1 },
        lastOpAt: new Date(),
      },
    })
    return next
  })

  deps.cache.evict(input.pageId)
  deps.cache.set(input.pageId, {
    workbook,
    seq,
    engineVersion: engineVersion(),
    bytes: bytes.byteLength,
  })

  const snapshot = await createSpreadsheetSnapshot(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    actor: input.actor,
    attribution: input.attribution,
    reason: 'import',
    changeComment: `import: ${input.filename}`,
  })

  return { versionId: snapshot.versionId, warnings }
}

export type ConvertFileInput = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
  title?: string
}

/**
 * A `.xlsx` or `.csv` file node becomes a spreadsheet page beside it. The
 * original file node is kept: converting is an addition, never a replacement.
 */
export const stageFileConversion = async (
  deps: SpreadsheetServiceDeps,
  input: ConvertFileInput,
): Promise<{
  page: KnowledgePageRecord
  attachmentId: string
  filename: string
  warnings: XlsxImportWarning[]
}> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: {
      id: true, title: true, kind: true, spaceId: true, projectId: true, parentPageId: true,
      taskId: true,
      versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { attachmentId: true } },
    },
  })
  if (!page) throw invalidRequest('Page not found', { pageId: input.pageId })
  if (page.kind !== 'file') {
    throw invalidRequest('Only an uploaded file can be opened as a spreadsheet', {
      pageId: input.pageId,
    })
  }
  const attachmentId = page.versions[0]?.attachmentId
  if (!attachmentId) throw invalidRequest('That file has no stored bytes', { pageId: input.pageId })

  const attachment = await deps.prisma.attachment.findFirst({
    where: { id: attachmentId, organizationId: input.organizationId },
    select: { filename: true },
  })
  const opened = await deps.fileService.openStream(attachmentId, input.organizationId)
  if (!opened) throw invalidRequest('That file could not be read', { pageId: input.pageId })
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Buffer))

  const staged = await stageSpreadsheetImport(deps, {
    organizationId: input.organizationId,
    spaceId: page.spaceId,
    projectId: page.projectId,
    title: input.title ?? page.title,
    filename: attachment?.filename ?? page.title,
    bytes: Buffer.concat(chunks),
    parentPageId: page.parentPageId,
    taskId: page.taskId,
    actor: input.actor,
    attribution: input.attribution,
    createdBy: input.actor.id,
  })
  return { ...staged, filename: attachment?.filename ?? page.title }
}
