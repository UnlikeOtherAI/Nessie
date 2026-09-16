import { exportCsv } from '@nessie/spreadsheet'

import { exportXlsxBytes } from './engine.js'
import { invalidRequest } from './errors.js'
import { loadHead, lockSpreadsheetPage, modelAtHead } from './head.js'
import { workbookForVersion } from './restore.js'
import { SPREADSHEET_XLSX_MIME } from './snapshot.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * Export: the live workbook, or a stored version's rendition.
 *
 * `saveToXlsx` is synchronous in the binding and blocks the event loop — about
 * 4 s for a million cells — so a large export belongs on the worker rather
 * than on an API request. At Nessie's caps a live export is tens of
 * milliseconds and the request path is the right place for it.
 */

/**
 * A downloaded CSV is opened in Excel far more often than it is parsed by a
 * script, and Excel needs both of these: CRLF line endings, and a UTF-8 BOM
 * without which it reads the file as the local code page and mangles every
 * non-ASCII name in it.
 */
const CSV_FOR_EXCEL = { newline: '\r\n', bom: true } as const

export type ExportFormat = 'xlsx' | 'csv'

export type SpreadsheetExport = {
  filename: string
  mime: string
  bytes: Buffer
}

export const exportSpreadsheet = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    format: ExportFormat
    /** Required for csv; xlsx always carries the whole workbook. */
    sheet?: number
    /** When set, the stored rendition rather than the live workbook. */
    versionId?: string
  },
): Promise<SpreadsheetExport> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: { title: true },
  })
  if (!page) throw invalidRequest('Page not found', { pageId: input.pageId })
  const base = (page.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'spreadsheet').slice(0, 120)

  if (input.versionId) {
    const workbook = await workbookForVersion(deps, {
      organizationId: input.organizationId,
      pageId: input.pageId,
      versionId: input.versionId,
    })
    return input.format === 'xlsx'
      ? { filename: `${base}.xlsx`, mime: SPREADSHEET_XLSX_MIME, bytes: exportXlsxBytes(workbook) }
      : {
          filename: `${base}.csv`,
          mime: 'text/csv; charset=utf-8',
          bytes: Buffer.from(exportCsv(workbook.model, input.sheet ?? 0, CSV_FOR_EXCEL), 'utf8'),
        }
  }

  return deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const workbook = await modelAtHead(deps, tx as never, head)
    if (input.format === 'xlsx') {
      return { filename: `${base}.xlsx`, mime: SPREADSHEET_XLSX_MIME, bytes: exportXlsxBytes(workbook) }
    }
    const sheet = input.sheet ?? 0
    const sheets = workbook.model.sheets()
    if (sheet < 0 || sheet >= sheets.length) {
      throw invalidRequest('That sheet does not exist', { sheet })
    }
    return {
      filename: `${base} - ${sheets[sheet]?.name ?? sheet}.csv`,
      mime: 'text/csv; charset=utf-8',
      bytes: Buffer.from(exportCsv(workbook.model, sheet, CSV_FOR_EXCEL), 'utf8'),
    }
  })
}

