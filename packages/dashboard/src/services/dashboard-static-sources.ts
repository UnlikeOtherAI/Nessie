/** Bounded JSON/CSV import for self-contained dashboards. */

import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import {
  ColumnKeySchema,
  DASHBOARD_DATASET_SCHEMA_VERSION,
  DASHBOARD_MAX_COLUMNS,
  DASHBOARD_MAX_DATASET_BYTES,
  DASHBOARD_MAX_ROWS,
  DASHBOARD_MAX_STRING_CODE_POINTS,
  DashboardDatasetSchema,
  type DashboardCell,
  type DashboardDataset,
  type DashboardOutputColumn,
} from '@nessie/schemas'
import { assertDashboardAccess } from '../access.js'
import { DashboardServiceError, type DashboardContext } from './dashboards.js'

export const DASHBOARD_STATIC_IMPORT_FORMATS = ['json', 'csv', 'xlsx', 'document', 'article'] as const
export type DashboardStaticImportFormat = (typeof DASHBOARD_STATIC_IMPORT_FORMATS)[number]

const normalizeKey = (label: string, index: number): string => {
  const candidate = label.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  const prefixed = /^[A-Za-z_]/.test(candidate) ? candidate : `column_${index + 1}`
  return ColumnKeySchema.parse(prefixed.slice(0, 64) || `column_${index + 1}`)
}

const parseCsv = (content: string): { headers: string[]; rows: string[][] } => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') {
      if (cell.length > 0) throw new DashboardServiceError(422, 'CSV_QUOTE_INVALID', 'quote occurs mid-cell')
      quoted = true
    } else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }
  if (quoted) throw new DashboardServiceError(422, 'CSV_QUOTE_UNCLOSED', 'CSV has an unclosed quoted cell')
  row.push(cell)
  if (row.some((value) => value.length > 0)) rows.push(row)
  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, '').trim())
  if (!headers || headers.length === 0 || headers.some((header) => !header)) {
    throw new DashboardServiceError(422, 'CSV_HEADERS_INVALID', 'CSV needs one non-empty header row')
  }
  if (headers.length > DASHBOARD_MAX_COLUMNS) {
    throw new DashboardServiceError(422, 'CSV_TOO_MANY_COLUMNS', `CSV has more than ${DASHBOARD_MAX_COLUMNS} columns`)
  }
  if (new Set(headers).size !== headers.length) {
    throw new DashboardServiceError(422, 'CSV_DUPLICATE_HEADER', 'CSV header names must be unique')
  }
  if (rows.length > DASHBOARD_MAX_ROWS) {
    throw new DashboardServiceError(422, 'CSV_TOO_MANY_ROWS', `CSV has more than ${DASHBOARD_MAX_ROWS} rows`)
  }
  if (rows.some((values) => values.length !== headers.length)) {
    throw new DashboardServiceError(422, 'CSV_ROW_WIDTH_INVALID', 'every CSV row must match the header width')
  }
  return { headers, rows }
}

const assertHeaders = (headers: string[], prefix: string): void => {
  if (headers.length === 0 || headers.some((header) => !header)) {
    throw new DashboardServiceError(422, `${prefix}_HEADERS_INVALID`, 'a source needs one non-empty header row')
  }
  if (headers.length > DASHBOARD_MAX_COLUMNS) {
    throw new DashboardServiceError(422, `${prefix}_TOO_MANY_COLUMNS`, `a source has more than ${DASHBOARD_MAX_COLUMNS} columns`)
  }
  if (new Set(headers).size !== headers.length) {
    throw new DashboardServiceError(422, `${prefix}_DUPLICATE_HEADER`, 'source header names must be unique')
  }
}

const decodeBase64 = (content: string): Buffer => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new DashboardServiceError(422, 'XLSX_ENCODING_INVALID', 'spreadsheet content must be base64')
  }
  return Buffer.from(content, 'base64')
}

export const staticSourceBytesFor = (format: DashboardStaticImportFormat, content: string): Buffer =>
  format === 'xlsx' ? decodeBase64(content) : Buffer.from(content, 'utf8')

/**
 * The imported XLSX is deliberately tiny, but ZIP compression can turn a tiny
 * archive into a large in-memory workbook. Inspect the central directory
 * before passing bytes to ExcelJS and reject ZIP64, encrypted, or oversized
 * expansion. This is a parser boundary, not merely a row-count nicety.
 */
const assertXlsxArchiveBudget = (bytes: Buffer): void => {
  const minimumEnd = 22
  let end = -1
  for (let index = bytes.length - minimumEnd; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      end = index
      break
    }
  }
  if (end < 0 || end + minimumEnd > bytes.length) {
    throw new DashboardServiceError(422, 'XLSX_INVALID', 'the spreadsheet is not a supported ZIP workbook')
  }
  const entryCount = bytes.readUInt16LE(end + 10)
  const directorySize = bytes.readUInt32LE(end + 12)
  const directoryOffset = bytes.readUInt32LE(end + 16)
  if (
    entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || entryCount > 2_000 || directoryOffset + directorySize > bytes.length
  ) {
    throw new DashboardServiceError(422, 'XLSX_ARCHIVE_UNSUPPORTED', 'the spreadsheet archive is too complex')
  }
  let offset = directoryOffset
  let expandedBytes = 0
  for (let count = 0; count < entryCount; count += 1) {
    if (offset + 46 > directoryOffset + directorySize || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new DashboardServiceError(422, 'XLSX_INVALID', 'the spreadsheet archive directory is invalid')
    }
    const flags = bytes.readUInt16LE(offset + 8)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    if ((flags & 0x1) !== 0) {
      throw new DashboardServiceError(422, 'XLSX_ENCRYPTED_UNSUPPORTED', 'encrypted spreadsheets are not supported')
    }
    expandedBytes += uncompressedSize
    if (expandedBytes > DASHBOARD_MAX_DATASET_BYTES * 8) {
      throw new DashboardServiceError(422, 'XLSX_EXPANSION_TOO_LARGE', 'spreadsheet expands beyond the import limit')
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
}

const xlsxCell = (value: ExcelJS.CellValue): DashboardCell => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return scalar(value)
  }
  if (typeof value === 'object' && 'formula' in value) {
    // ExcelJS only reads the workbook, but formulas make a rendered result
    // ambiguous and could have external-data semantics. We never calculate or
    // dereference them; callers can export values before import instead.
    throw new DashboardServiceError(422, 'XLSX_FORMULAS_UNSUPPORTED', 'spreadsheet formulas are not supported; export values first')
  }
  throw new DashboardServiceError(422, 'XLSX_CELL_UNSUPPORTED', 'spreadsheet cells must contain scalar values')
}

const parseXlsx = async (bytes: Buffer): Promise<{ headers: string[]; rows: DashboardCell[][] }> => {
  assertXlsxArchiveBudget(bytes)
  const workbook = new ExcelJS.Workbook()
  try {
    // `read` takes a Node stream. This avoids ExcelJS's stale global Buffer
    // declaration and, unlike a browser bridge, keeps parsing wholly local.
    await workbook.xlsx.read(Readable.from([bytes]))
  } catch (error) {
    if (error instanceof DashboardServiceError) throw error
    throw new DashboardServiceError(422, 'XLSX_INVALID', 'the spreadsheet could not be read')
  }
  const worksheet = workbook.worksheets.find((sheet) => sheet.state === 'visible')
  if (!worksheet) {
    throw new DashboardServiceError(422, 'XLSX_SHEET_MISSING', 'the spreadsheet has no visible worksheet')
  }
  if (worksheet.rowCount < 2) {
    throw new DashboardServiceError(422, 'XLSX_ROWS_INVALID', 'the spreadsheet needs a header row and at least one data row')
  }
  const headers = Array.from({ length: worksheet.columnCount }, (_, index) => {
    const value = worksheet.getRow(1).getCell(index + 1).value
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
    return String(value).trim()
  })
  assertHeaders(headers, 'XLSX')
  const rows: DashboardCell[][] = []
  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    if (rows.length >= DASHBOARD_MAX_ROWS) {
      throw new DashboardServiceError(422, 'XLSX_TOO_MANY_ROWS', `spreadsheet has more than ${DASHBOARD_MAX_ROWS} rows`)
    }
    const row = worksheet.getRow(rowIndex)
    rows.push(headers.map((_, columnIndex) => xlsxCell(row.getCell(columnIndex + 1).value)))
  }
  return { headers, rows }
}

const parseText = (content: string, format: 'document' | 'article') => {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) {
    throw new DashboardServiceError(422, 'TEXT_EMPTY', 'the supplied document has no extractable text')
  }
  if (lines.length > DASHBOARD_MAX_ROWS) {
    throw new DashboardServiceError(422, 'TEXT_TOO_MANY_LINES', `the document has more than ${DASHBOARD_MAX_ROWS} lines`)
  }
  return {
    headers: ['sourceIndex', format === 'article' ? 'articleText' : 'documentText'],
    rows: lines.map((line, index) => [index + 1, scalar(line)]),
  }
}

const scalar = (value: unknown): DashboardCell => {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    if ([...value].length > DASHBOARD_MAX_STRING_CODE_POINTS) {
      throw new DashboardServiceError(422, 'SOURCE_STRING_TOO_LONG', 'a cell exceeds the dashboard string limit')
    }
    return value
  }
  throw new DashboardServiceError(422, 'SOURCE_CELL_UNSUPPORTED', 'only string, number, boolean and null cells are supported')
}

/** CSV carries no native types, so only unambiguous literals become scalars. */
const csvCell = (value: string): DashboardCell => {
  if (value === 'true') return true
  if (value === 'false') return false
  // Keep identifiers such as 007 as text; otherwise a chart needs numeric
  // values from ordinary CSV exports. Exponents, locale formats and formulas
  // intentionally remain text rather than getting guessed at.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && !/^0\d/.test(value)) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return scalar(value)
}

const inferType = (values: DashboardCell[]): DashboardOutputColumn['type'] => {
  const present = values.filter((value) => value !== null)
  if (present.every((value) => typeof value === 'number')) return 'number'
  if (present.every((value) => typeof value === 'boolean')) return 'boolean'
  return 'string'
}

export const parseStaticDataset = async (input: {
  format: DashboardStaticImportFormat
  content: string
}): Promise<DashboardDataset> => {
  const sourceBytes = staticSourceBytesFor(input.format, input.content)
  if (sourceBytes.byteLength > DASHBOARD_MAX_DATASET_BYTES) {
    throw new DashboardServiceError(422, 'SOURCE_TOO_LARGE', 'source is larger than the dashboard import limit')
  }
  let headers: string[]
  let rawRows: DashboardCell[][]
  if (input.format === 'csv') {
    const csv = parseCsv(input.content)
    headers = csv.headers
    rawRows = csv.rows.map((row) => row.map(csvCell))
  } else if (input.format === 'xlsx') {
    const xlsx = await parseXlsx(sourceBytes)
    headers = xlsx.headers
    rawRows = xlsx.rows
  } else if (input.format === 'document' || input.format === 'article') {
    const text = parseText(input.content, input.format)
    headers = text.headers
    rawRows = text.rows
  } else {
    let decoded: unknown
    try {
      decoded = JSON.parse(input.content)
    } catch {
      throw new DashboardServiceError(422, 'JSON_INVALID', 'the source is not valid JSON')
    }
    const records = Array.isArray(decoded)
      ? decoded
      : decoded && typeof decoded === 'object' && Array.isArray((decoded as { rows?: unknown }).rows)
        ? (decoded as { rows: unknown[] }).rows
        : null
    if (!records || records.length > DASHBOARD_MAX_ROWS || records.some((record) => !record || Array.isArray(record) || typeof record !== 'object')) {
      throw new DashboardServiceError(422, 'JSON_ROWS_INVALID', 'JSON must be an array of records with at most 2,000 rows')
    }
    headers = Array.from(new Set(records.flatMap((record) => Object.keys(record as Record<string, unknown>))))
    if (headers.length === 0 || headers.length > DASHBOARD_MAX_COLUMNS) {
      throw new DashboardServiceError(422, 'JSON_COLUMNS_INVALID', 'JSON needs 1–32 record fields')
    }
    rawRows = records.map((record) =>
      headers.map((header) => scalar((record as Record<string, unknown>)[header] ?? null)),
    )
  }

  const keys = headers.map(normalizeKey)
  if (new Set(keys).size !== keys.length) {
    throw new DashboardServiceError(422, 'SOURCE_COLUMN_KEY_COLLISION', 'source headers normalize to duplicate column names')
  }
  const rows = rawRows.map((values) => Object.fromEntries(
    values.map((value, index) => [keys[index]!, scalar(value)]),
  ))
  const columns: DashboardOutputColumn[] = headers.map((label, index) => {
    const values = rows.map((row) => row[keys[index]!] as DashboardCell)
    return { key: keys[index]!, label, type: inferType(values), nullable: values.some((value) => value === null) }
  })
  const dataset = DashboardDatasetSchema.parse({
    schemaVersion: DASHBOARD_DATASET_SCHEMA_VERSION,
    columns,
    rows,
    fetchedAt: new Date().toISOString(),
  })
  if (Buffer.byteLength(JSON.stringify(dataset), 'utf8') > DASHBOARD_MAX_DATASET_BYTES) {
    throw new DashboardServiceError(422, 'NORMALIZED_DATASET_TOO_LARGE', 'normalized dashboard data exceeds the import limit')
  }
  return dataset
}

/** Server-authored notes only: source data never travels in attribution chrome. */
export const listDashboardSourceNotes = async (context: DashboardContext, dashboardId: string) => {
  await assertDashboardAccess({
    prisma: context.prisma,
    membership: context.membership,
    actor: context.actor,
    resource: { type: 'dashboard', id: dashboardId },
    capability: 'view',
  })
  const widgets = await context.prisma.dashboardWidget.findMany({
    where: { dashboardId, organizationId: context.actor.organizationId },
    select: {
      source: {
        select: {
          id: true,
          name: true,
          kind: true,
          lastValidatedAt: true,
          material: {
            select: {
              sourceReference: true,
              canonicalUrl: true,
              parser: true,
              contentDigest: true,
              originalAttachmentId: true,
            },
          },
        },
      },
    },
  })
  const unique = new Map(widgets.map(({ source }) => [source.id, source]))
  return [...unique.values()].map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    lastValidatedAt: source.lastValidatedAt,
    sourceReference: source.material?.sourceReference ?? null,
    canonicalUrl: source.material?.canonicalUrl ?? null,
    parser: source.material?.parser ?? null,
    contentDigest: source.material?.contentDigest ?? null,
    originalAttachmentId: source.material?.originalAttachmentId ?? null,
  }))
}
