// What an .xlsx loses when it goes through IronCalc.
//
// `UserModel.fromXlsx` reports nothing about what it discarded, so the import
// route derives the warnings itself from the uploaded package: the zip entry
// names answer for whole parts (charts, drawings, pivot caches, comments,
// macros, …) and a marker scan of the sheet XML answers for features that
// live inside `xl/worksheets/sheetN.xml` and have no part of their own
// (autofilter, data validation, hyperlinks, protection, outlines).
//
// Every entry in `XLSX_PART_LOSSES` and `XLSX_MARKER_LOSSES` below was
// measured on `@ironcalc/nodejs` 0.8.3 in Spike B
// (docs/plans/2026-09-15-spreadsheets-ironcalc/spike-b-xlsx.md): a foreign
// (exceljs) writer produced the feature, IronCalc imported and re-exported,
// and the feature was gone from the output. Nothing is listed here on
// suspicion.
//
// Node-only: the zip reader uses `node:zlib`. Phase 1 should re-export this
// module from `src/node.ts`, never from the browser entry point.

import { inflateRawSync } from 'node:zlib'

/** A stable identifier for one class of loss; stored with the page. */
export type XlsxWarningCode =
  | 'charts'
  | 'images'
  | 'pivot_tables'
  | 'comments'
  | 'macros'
  | 'external_links'
  | 'form_controls'
  | 'slicers'
  | 'embedded_objects'
  | 'data_connections'
  | 'custom_xml'
  | 'tables'
  | 'autofilter'
  | 'data_validation'
  | 'hyperlinks'
  | 'sheet_protection'
  | 'outlines'
  | 'sparklines'

export interface XlsxImportWarning {
  code: XlsxWarningCode
  /** One sentence for the person who uploaded the file. */
  message: string
  /**
   * The zip entries or sheet parts that triggered it, capped at
   * `MAX_EVIDENCE` so a workbook with 400 charts does not write 400 rows.
   */
  evidence: string[]
}

const MAX_EVIDENCE = 8

interface PartLoss {
  code: XlsxWarningCode
  message: string
  matches: (name: string) => boolean
}

const startsWith =
  (...prefixes: string[]) =>
  (name: string): boolean =>
    prefixes.some((p) => name.startsWith(p))

/**
 * Losses visible in the package's part list alone. Order is the order the
 * warnings come out in, most consequential first.
 */
export const XLSX_PART_LOSSES: readonly PartLoss[] = [
  {
    code: 'charts',
    message: 'Charts were removed — Nessie spreadsheets do not carry charts yet.',
    matches: startsWith('xl/charts/', 'xl/chartsheets/'),
  },
  {
    code: 'pivot_tables',
    message: 'Pivot tables were removed; their source data was kept as ordinary cells.',
    matches: startsWith('xl/pivotCache/', 'xl/pivotTables/'),
  },
  {
    code: 'images',
    message: 'Images, shapes and other drawings were removed.',
    matches: (name) =>
      startsWith('xl/media/', 'xl/drawings/')(name) && !name.endsWith('.vml'),
  },
  {
    code: 'comments',
    message: 'Cell comments and notes were removed.',
    matches: (name) =>
      /^xl\/comments\d*\.xml$/.test(name) ||
      startsWith('xl/threadedComments/')(name) ||
      name === 'xl/persons.xml',
  },
  {
    code: 'macros',
    message: 'Macros (VBA) were removed. Nessie never runs workbook macros.',
    matches: (name) => name === 'xl/vbaProject.bin' || name === 'xl/vbaProjectSignature.bin',
  },
  {
    code: 'external_links',
    message: 'Links to other workbooks were removed; the cells keep their last cached values.',
    matches: startsWith('xl/externalLinks/'),
  },
  {
    code: 'tables',
    message:
      'Excel tables became plain ranges — the table name, banded styling and filter buttons were removed.',
    matches: startsWith('xl/tables/'),
  },
  {
    code: 'form_controls',
    message: 'Form and ActiveX controls (buttons, checkboxes, drop-downs) were removed.',
    matches: startsWith('xl/ctrlProps/', 'xl/activeX/'),
  },
  {
    code: 'slicers',
    message: 'Slicers and timelines were removed.',
    matches: startsWith('xl/slicers/', 'xl/slicerCaches/', 'xl/timelines/', 'xl/timelineCaches/'),
  },
  {
    code: 'embedded_objects',
    message: 'Embedded objects (OLE documents, attachments) were removed.',
    matches: startsWith('xl/embeddings/'),
  },
  {
    code: 'data_connections',
    message: 'External data connections and queries were removed.',
    matches: (name) => name === 'xl/connections.xml' || name.startsWith('xl/queryTables/'),
  },
  {
    code: 'custom_xml',
    message: 'Custom XML parts were removed.',
    matches: startsWith('customXml/'),
  },
]

interface MarkerLoss {
  code: XlsxWarningCode
  message: string
  pattern: RegExp
}

/**
 * Losses that live inside a worksheet part. Each pattern is deliberately
 * narrow: exceljs (and Excel) emit `<pageSetup/>` and `outlineLevel="0"` on
 * sheets that use neither, so a loose marker would warn about nothing.
 */
export const XLSX_MARKER_LOSSES: readonly MarkerLoss[] = [
  {
    code: 'autofilter',
    message:
      'Autofilters were removed. Nessie has its own filters — set them again from the toolbar.',
    pattern: /<(?:\w+:)?autoFilter[\s/>]/,
  },
  {
    code: 'data_validation',
    message: 'Data validation rules (drop-down lists, value limits) were removed.',
    pattern: /<(?:\w+:)?dataValidation[\s/>]/,
  },
  {
    code: 'hyperlinks',
    message: 'Cell hyperlinks were removed; the link text stayed as ordinary text.',
    pattern: /<(?:\w+:)?hyperlink[\s/>]/,
  },
  {
    code: 'sheet_protection',
    message: 'Sheet and workbook protection was removed — Nessie uses its own permissions.',
    pattern: /<(?:\w+:)?sheetProtection[\s/>]/,
  },
  {
    code: 'outlines',
    message: 'Grouped (outlined) rows and columns were flattened.',
    pattern: /outlineLevel="[1-9]/,
  },
  {
    code: 'sparklines',
    message: 'Sparklines were removed.',
    pattern: /<(?:\w+:)?sparklineGroup[\s/>]/,
  },
]

const WORKSHEET_PART = /^xl\/(worksheets|chartsheets)\/[^/]+\.xml$/

/** The inputs the pure derivation needs; both come from the uploaded zip. */
export interface XlsxScan {
  /** Every zip entry name, directory entries included or not — both work. */
  parts: readonly string[]
  /** `[part name, XML text]` for each worksheet part, for the marker scan. */
  sheets?: ReadonlyArray<readonly [string, string]>
}

function push(
  into: Map<XlsxWarningCode, XlsxImportWarning>,
  code: XlsxWarningCode,
  message: string,
  item: string,
): void {
  const existing = into.get(code)
  if (!existing) {
    into.set(code, { code, message, evidence: [item] })
    return
  }
  if (existing.evidence.length < MAX_EVIDENCE && !existing.evidence.includes(item)) {
    existing.evidence.push(item)
  }
}

/**
 * The user-facing warnings for one uploaded workbook. Pure: no I/O, no
 * engine, deterministic order (part losses in catalogue order, then marker
 * losses in catalogue order).
 */
export function deriveXlsxWarnings(scan: XlsxScan): XlsxImportWarning[] {
  const found = new Map<XlsxWarningCode, XlsxImportWarning>()
  const names = scan.parts.map((n) => n.replace(/^\/+/, '')).filter((n) => !n.endsWith('/'))
  for (const loss of XLSX_PART_LOSSES) {
    for (const name of names) if (loss.matches(name)) push(found, loss.code, loss.message, name)
  }
  for (const loss of XLSX_MARKER_LOSSES) {
    for (const [name, xml] of scan.sheets ?? []) {
      if (loss.pattern.test(xml)) push(found, loss.code, loss.message, name)
    }
  }
  const order = [
    ...XLSX_PART_LOSSES.map((l) => l.code),
    ...XLSX_MARKER_LOSSES.map((l) => l.code),
  ]
  return order.flatMap((code) => {
    const warning = found.get(code)
    return warning ? [warning] : []
  })
}

/** What the first bytes of an upload say the file really is. */
export type WorkbookFormat = 'xlsx' | 'xls' | 'csv-or-text' | 'unknown'

const ZIP_MAGIC = [0x50, 0x4b]
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/**
 * Sniffs the container before the engine sees it. IronCalc answers every bad
 * upload with the same `Zip Error: … Could not find central directory end`,
 * so a legacy `.xls` and a truncated `.xlsx` are indistinguishable from its
 * message; the import route decides here instead.
 */
export function detectWorkbookFormat(head: Uint8Array): WorkbookFormat {
  if (OLE2_MAGIC.every((b, i) => head[i] === b)) return 'xls'
  if (ZIP_MAGIC.every((b, i) => head[i] === b)) return 'xlsx'
  if (head.length === 0) return 'unknown'
  // Anything that decodes as printable text is most likely a CSV the person
  // renamed; the route offers the CSV path rather than "corrupt file".
  const sample = head.subarray(0, 512)
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    if (byte < 0x20 || byte === 0x7f) return 'unknown'
  }
  return 'csv-or-text'
}

interface ZipEntry {
  name: string
  method: number
  offset: number
  compressedSize: number
  /** What the package *declares* it expands to. Never inflated to learn it. */
  uncompressedSize: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const min = Math.max(0, bytes.length - 0xffff - 22)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i
  }
  return -1
}

/**
 * Reads the zip central directory. Dependency-free on purpose: this runs on
 * an upload of unknown provenance inside the API process, and the only work
 * it does before the size checks is walk a table of names.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(bytes, view)
  if (eocd < 0) throw new Error('XLSX_NOT_A_ZIP')
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error('XLSX_CENTRAL_DIRECTORY_CORRUPT')
    }
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      offset: view.getUint32(cursor + 42, true),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(bytes: Uint8Array, entry: ZipEntry): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const nameLength = view.getUint16(entry.offset + 26, true)
  const extraLength = view.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const raw = bytes.subarray(start, start + entry.compressedSize)
  const data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(Buffer.from(raw))
  return data.toString('utf8')
}

/** Every entry name in the package, without decompressing anything. */
export function readXlsxPartNames(bytes: Uint8Array): string[] {
  return readCentralDirectory(bytes).map((e) => e.name)
}

/**
 * How much the package declares it expands to, summed across its entries, or
 * `null` when the bytes are not a readable 32-bit zip at all.
 *
 * This, and not the file size, is what an import cap has to be written
 * against: sheet XML decompresses about 11:1, so a 3.27 MB workbook already
 * needs ~864 MB resident and a 64 MiB one could need roughly 15 GB (spike B
 * §"Contract changes" 5). The figure comes from the central directory, so
 * nothing is inflated to learn it.
 */
export function declaredUncompressedBytes(bytes: Uint8Array): number | null {
  try {
    return readCentralDirectory(bytes).reduce((total, entry) => total + entry.uncompressedSize, 0)
  } catch {
    return null
  }
}

/**
 * The end-to-end call the import route makes: part names plus the worksheet
 * XML the marker scan needs. `maxSheetBytes` caps how much sheet XML is
 * inflated for the scan — a 600 KB sheet part is common and the markers we
 * look for are in the first and last few KB, but a workbook is not allowed
 * to make us inflate hundreds of megabytes just to produce a warning list.
 */
export function scanXlsxWarnings(
  bytes: Uint8Array,
  { maxSheetBytes = 32 * 1024 * 1024 }: { maxSheetBytes?: number } = {},
): XlsxImportWarning[] {
  const entries = readCentralDirectory(bytes)
  const sheets: Array<readonly [string, string]> = []
  let budget = maxSheetBytes
  for (const entry of entries) {
    if (!WORKSHEET_PART.test(entry.name)) continue
    if (entry.compressedSize > budget) continue
    budget -= entry.compressedSize
    try {
      sheets.push([entry.name, readEntry(bytes, entry)])
    } catch {
      // A sheet we cannot inflate produces no markers; the part-name losses
      // are still reported. A wholly unreadable package already threw above.
    }
  }
  return deriveXlsxWarnings({ parts: entries.map((e) => e.name), sheets })
}
