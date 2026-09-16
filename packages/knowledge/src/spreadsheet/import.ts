import { Readable } from 'node:stream'

import type { LedgerAttribution } from '@nessie/runtime'

import {
  createEmptyWorkbook,
  importXlsxBytes,
  pasteBlock,
  type SpreadsheetWorkbook,
} from './engine.js'
import { writeSpreadsheetHead } from './create.js'
import { invalidRequest, tooLarge, unsupportedFeature } from './errors.js'
import { createSpreadsheetSnapshot } from './snapshot.js'
import { detectWorkbookFormat, inspectXlsx, type XlsxWarning } from './xlsx-inspect.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'
import type { KnowledgePageRecord } from '../types.js'

/**
 * Import, and converting an uploaded file node into a spreadsheet.
 *
 * The caps below are the spike's, not the plan's: a 3.27 MB xlsx already needs
 * ~864 MB resident and sheet XML decompresses about 11:1, so the plan's 64 MiB
 * parse cap would admit a workbook needing roughly 15 GB. The binding has no
 * cap of its own, so this is the only place one exists.
 *
 * TODO(coordinator): these three numbers belong in `SPREADSHEET_LIMITS`
 * (`packages/schemas/src/spreadsheet.ts`, which Phase 0 owns) as
 * `maxImportBytes` / `maxImportUncompressedBytes` / `maxImportCells`. They are
 * here so this phase is buildable; moving them is an import change.
 */
export const SPREADSHEET_IMPORT_LIMITS = {
  /** Compressed upload size. */
  maxImportBytes: 16 * 1024 * 1024,
  /** Declared uncompressed size across the whole package (~2 M cells, ~1.7 GB RSS). */
  maxImportUncompressedBytes: 256 * 1024 * 1024,
  /** A CSV is not compressed, so its own cap is lower. */
  maxCsvBytes: 32 * 1024 * 1024,
} as const

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
  warnings: XlsxWarning[]
}

const parseCsv = (text: string): string[][] => {
  // RFC 4180: quotes, doubled quotes inside them, embedded newlines and CRLF.
  // `pasteCsvString` cannot do this — despite its name it splits on TABS — so
  // a CSV is parsed here and handed over as a tab-joined block.
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** The workbook an upload becomes, with whatever the import will lose. */
export const workbookFromUpload = (
  filename: string,
  bytes: Buffer,
): { workbook: SpreadsheetWorkbook; warnings: XlsxWarning[] } => {
  const format = detectWorkbookFormat(bytes.subarray(0, 1_024))

  if (format === 'xls') {
    // Refused by name, not by the engine's message: its error for a 1997 file
    // is byte-identical to its error for a corrupt zip.
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
    const inspection = inspectXlsx(bytes)
    if (!inspection.entries) {
      throw unsupportedFeature('That file could not be read as a workbook', { filename })
    }
    if (inspection.declaredUncompressedBytes > SPREADSHEET_IMPORT_LIMITS.maxImportUncompressedBytes) {
      throw tooLarge('That workbook expands to more than this instance will open', {
        uncompressedBytes: inspection.declaredUncompressedBytes,
        maxUncompressedBytes: SPREADSHEET_IMPORT_LIMITS.maxImportUncompressedBytes,
      })
    }
    return { workbook: importXlsxBytes(bytes), warnings: inspection.warnings }
  }

  if (format === 'csv-or-text') {
    if (bytes.byteLength > SPREADSHEET_IMPORT_LIMITS.maxCsvBytes) {
      throw tooLarge('That file is too large to import', {
        bytes: bytes.byteLength,
        maxBytes: SPREADSHEET_IMPORT_LIMITS.maxCsvBytes,
      })
    }
    const rows = parseCsv(bytes.toString('utf8'))
    if (rows.length === 0) throw invalidRequest('That file has no rows', { filename })
    const workbook = createEmptyWorkbook('Sheet1')
    pasteBlock(workbook, 0, 1, 1, rows)
    workbook.model.evaluate()
    return { workbook, warnings: [] }
  }

  throw unsupportedFeature('That file is not a spreadsheet', { filename })
}

export const importSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: ImportSpreadsheetInput,
): Promise<ImportSpreadsheetResult> => {
  const { workbook, warnings } = workbookFromUpload(input.filename, input.bytes)

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

  await deps.prisma.$transaction((tx) =>
    writeSpreadsheetHead(tx, {
      pageId: page.id,
      organizationId: input.organizationId,
      workbook,
    }),
  )
  deps.cache.set(page.id, {
    workbook,
    seq: 0,
    engineVersion: (await import('./engine.js')).engineVersion(),
    bytes: 0,
  })

  // The upload itself is kept beside the page, so "what did I actually send?"
  // has an answer that no import decision can take away.
  await deps.fileService
    .store({
      attribution: input.attribution,
      body: Readable.from([input.bytes]),
      filename: input.filename,
      mime: 'application/octet-stream',
      organizationId: input.organizationId,
      scope: { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId },
      uploaderId: input.actor.type === 'user' ? input.actor.id : null,
      knowledgePageId: page.id,
    })
    .catch(() => undefined)

  const snapshot = await createSpreadsheetSnapshot(deps, {
    organizationId: input.organizationId,
    pageId: page.id,
    actor: input.actor,
    attribution: input.attribution,
    reason: 'import',
    changeComment: `import: ${input.filename}`,
  })

  return { page, versionId: snapshot.versionId, warnings }
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
export const convertFileToSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: ConvertFileInput,
): Promise<ImportSpreadsheetResult> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: {
      id: true, title: true, kind: true, spaceId: true, projectId: true, parentPageId: true,
      taskId: true,
      versions: {
        orderBy: { versionNumber: 'desc' },
        take: 1,
        select: { attachmentId: true },
      },
    },
  })
  if (!page) throw invalidRequest('Page not found', { pageId: input.pageId })
  if (page.kind !== 'file') {
    throw invalidRequest('Only an uploaded file can be opened as a spreadsheet', { pageId: input.pageId })
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

  return importSpreadsheet(deps, {
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
}
