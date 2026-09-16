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

export type ExportFormat = 'xlsx' | 'csv'

export type SpreadsheetExport = {
  filename: string
  mime: string
  bytes: Buffer
}

const csvCell = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

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
      seq: null,
    })
    return input.format === 'xlsx'
      ? { filename: `${base}.xlsx`, mime: SPREADSHEET_XLSX_MIME, bytes: exportXlsxBytes(workbook) }
      : {
          filename: `${base}.csv`,
          mime: 'text/csv; charset=utf-8',
          bytes: Buffer.from(renderCsv(workbook.model, input.sheet ?? 0), 'utf8'),
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
      bytes: Buffer.from(renderCsv(workbook.model, sheet), 'utf8'),
    }
  })
}

/**
 * CSV is ours, not the engine's: formatted values within the used range, RFC
 * 4180 quoting. Hidden columns still export — the engine carries them as
 * width 0 and a download is a copy of the data, not of the view.
 */
export const renderCsv = (
  model: Parameters<typeof exportXlsxBytes>[0]['model'],
  sheet: number,
): string => {
  const [minRow, minColumn, maxRow, maxColumn] = model.dimensions(sheet)
  const lines: string[] = []
  for (let row = minRow; row <= maxRow; row++) {
    const cells: string[] = []
    for (let column = minColumn; column <= maxColumn; column++) {
      cells.push(csvCell(model.formattedValue(sheet, row, column) ?? ''))
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    lines.push(cells.join(','))
  }
  return lines.join('\r\n')
}
