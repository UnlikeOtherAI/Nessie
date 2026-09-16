import { inflateRawSync } from 'node:zlib'

/**
 * What can be learned about an upload *before* the engine sees it.
 *
 * Three things need this, and none of them can come from the engine:
 *
 * 1. **Which format it is.** The engine's error for a legacy `.xls` is
 *    byte-identical to its error for a corrupt zip ("Could not find central
 *    directory end"), so without sniffing, a person who uploaded a 1997 file
 *    is told their file is broken.
 * 2. **How big it will get.** Sheet XML decompresses about 11:1 and a 3.27 MB
 *    xlsx already needs ~864 MB resident — a 64 MiB file cap would admit a
 *    workbook needing ~15 GB. The cap has to be on the *declared uncompressed*
 *    size in the central directory, which is knowable without inflating.
 * 3. **What will be lost.** Autofilter, data validation, hyperlinks, sheet
 *    protection and outlines have no part of their own: they are attributes
 *    inside `xl/worksheets/sheetN.xml`. A part-list comparison alone would
 *    silently drop exactly the things a person notices.
 *
 * TODO(Phase 1): `packages/spreadsheet/src/xlsx-warnings.ts` (spike B) is the
 * home for this — `deriveXlsxWarnings`, `scanXlsxWarnings` and
 * `detectWorkbookFormat` with a fuller rule catalogue. This is the narrow
 * version the import route needs now; delete it and import that one when the
 * branch lands.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/spike-b-xlsx.md
 */

export type WorkbookFormat = 'xlsx' | 'xls' | 'csv-or-text' | 'unknown'

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export const detectWorkbookFormat = (head: Buffer): WorkbookFormat => {
  if (head.length >= 8 && head.subarray(0, 8).equals(OLE2_MAGIC)) return 'xls'
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'xlsx'
  // Printable-ish and no NULs in the first kilobyte reads as text.
  const sample = head.subarray(0, 1_024)
  if (sample.length > 0 && !sample.includes(0)) return 'csv-or-text'
  return 'unknown'
}

export type ZipEntry = {
  name: string
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  method: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

/**
 * The zip central directory, read without a dependency. Only the fields the
 * caps and the warnings need; a zip64 archive (no 32-bit EOCD in the last
 * 64 KiB) is reported as unreadable rather than guessed at.
 */
export const readZipCentralDirectory = (bytes: Buffer): ZipEntry[] | null => {
  const search = Math.min(bytes.length, 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= bytes.length - search && offset >= 0; offset--) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd === -1) return null

  const count = bytes.readUInt16LE(eocd + 10)
  let cursor = bytes.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42)
    entries.push({
      name: bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      method,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const readEntry = (bytes: Buffer, entry: ZipEntry): string | null => {
  const offset = entry.localHeaderOffset
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) return null
  const nameLength = bytes.readUInt16LE(offset + 26)
  const extraLength = bytes.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const body = bytes.subarray(start, start + entry.compressedSize)
  try {
    if (entry.method === 0) return body.toString('utf8')
    if (entry.method === 8) return inflateRawSync(body).toString('utf8')
  } catch {
    return null
  }
  return null
}

/** A loss the import will cause, in the words the route reports to a person. */
export type XlsxWarning = { code: string; message: string }

const PART_LOSSES: { code: string; test: (name: string) => boolean; message: string }[] = [
  { code: 'charts', test: (n) => n.startsWith('xl/charts/'), message: 'Charts were not imported.' },
  { code: 'images', test: (n) => n.startsWith('xl/media/') || n.startsWith('xl/drawings/'), message: 'Images and drawings were not imported.' },
  { code: 'pivot_tables', test: (n) => n.startsWith('xl/pivotCache/') || n.startsWith('xl/pivotTables/'), message: 'Pivot tables were not imported.' },
  { code: 'comments', test: (n) => n.startsWith('xl/comments') || n.endsWith('.vml'), message: 'Cell comments were not imported.' },
  { code: 'tables', test: (n) => n.startsWith('xl/tables/'), message: 'Excel tables became plain ranges.' },
  { code: 'macros', test: (n) => n.startsWith('xl/vbaProject'), message: 'Macros were not imported.' },
  { code: 'slicers', test: (n) => n.startsWith('xl/slicer'), message: 'Slicers were not imported.' },
  { code: 'external_links', test: (n) => n.startsWith('xl/externalLinks/'), message: 'Links to other workbooks were not imported.' },
  { code: 'queries', test: (n) => n.startsWith('xl/queryTables/') || n.startsWith('xl/connections'), message: 'Data connections were not imported.' },
]

const MARKER_LOSSES: { code: string; marker: RegExp; message: string }[] = [
  { code: 'autofilter', marker: /<autoFilter\s+ref=/, message: 'The autofilter was not imported; set a filter in Nessie instead.' },
  { code: 'data_validation', marker: /<dataValidation[\s>]/, message: 'Data validation rules were not imported.' },
  { code: 'hyperlinks', marker: /<hyperlink\s+ref=/, message: 'Hyperlinks were not imported; their text remains.' },
  { code: 'sheet_protection', marker: /<sheetProtection[\s/>]/, message: 'Sheet protection was not imported.' },
  { code: 'outlines', marker: /outlineLevel(Row|Col)?="[1-9]/, message: 'Row and column grouping was flattened.' },
  { code: 'merged_cells', marker: /<mergeCell\s+ref=/, message: 'Merged cells are not editable in Nessie; they survive a download but cannot be changed.' },
]

/** How much worksheet XML the marker scan will inflate before it gives up. */
const MARKER_SCAN_BUDGET_BYTES = 32 * 1024 * 1024

export type XlsxInspection = {
  format: WorkbookFormat
  /** Null when the container could not be read as a 32-bit zip at all. */
  entries: ZipEntry[] | null
  declaredUncompressedBytes: number
  warnings: XlsxWarning[]
}

export const inspectXlsx = (bytes: Buffer): XlsxInspection => {
  const format = detectWorkbookFormat(bytes.subarray(0, 1_024))
  if (format !== 'xlsx') {
    return { format, entries: null, declaredUncompressedBytes: 0, warnings: [] }
  }
  const entries = readZipCentralDirectory(bytes)
  if (!entries) {
    return { format, entries: null, declaredUncompressedBytes: 0, warnings: [] }
  }

  const declaredUncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0)
  const found = new Set<string>()
  for (const entry of entries) {
    for (const rule of PART_LOSSES) {
      if (rule.test(entry.name)) found.add(rule.code)
    }
  }

  // The markers are deliberately narrow: Excel and exceljs both write inert
  // `<pageSetup/>`, `<headerFooter/>` and `outlineLevel="0"` on sheets that use
  // none of them, and a loose marker would warn about every upload.
  let budget = MARKER_SCAN_BUDGET_BYTES
  for (const entry of entries) {
    if (!entry.name.startsWith('xl/worksheets/') || !entry.name.endsWith('.xml')) continue
    if (entry.uncompressedSize > budget) break
    budget -= entry.uncompressedSize
    const xml = readEntry(bytes, entry)
    if (!xml) continue
    for (const rule of MARKER_LOSSES) {
      if (rule.marker.test(xml)) found.add(rule.code)
    }
  }

  const catalogue = [...PART_LOSSES, ...MARKER_LOSSES]
  return {
    format,
    entries,
    declaredUncompressedBytes,
    warnings: catalogue
      .filter((rule) => found.has(rule.code))
      .map((rule) => ({ code: rule.code, message: rule.message })),
  }
}
