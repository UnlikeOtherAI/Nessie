import { SPREADSHEET_LIMITS, type SpreadsheetBatchSummary, type SpreadsheetSelection } from '@nessie/schemas'

import { rectangleOf, tooLarge } from './a1.js'
import type { SpreadsheetEngineModel } from './engine.js'
import { usedRange } from './read.js'
import { runPaused, summaryOf } from './write.js'

// CSV in and out.
//
// Import does NOT delegate to the engine's `pasteCsvString`, despite the name:
// Spike B measured it as tab-separated — `"a,b,c"` lands in a single cell — and
// it also needs the model's selected cell parked on a corner of the target area
// first, and treats that area as an anchor rather than a clamp, so it writes
// past whatever you pass. Parsing here and writing through `setUserInput` costs
// about the same, bounds the write exactly, and touches no selection state the
// person is looking at. (spike-b-xlsx.md §"CSV")
//
// Export is ours either way: the engine has no CSV writer.

const BOM = '﻿'

export interface ParseCsvOptions {
  /** Defaults to sniffing `,`, `;` and `\t` from the first line. */
  delimiter?: string
}

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/))
  let inQuotes = false
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i]!
    if (char === '"') {
      if (inQuotes && firstLine[i + 1] === '"') i++
      else inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && char in counts) counts[char] = (counts[char] ?? 0) + 1
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0] : ','
}

/** RFC 4180: quoted fields, embedded delimiters, newlines and doubled quotes. */
export function parseCsv(text: string, options: ParseCsvOptions = {}): string[][] {
  let source = text
  if (source.startsWith(BOM)) source = source.slice(BOM.length)
  const delimiter = options.delimiter ?? sniffDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnything = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') {
      inQuotes = true
      sawAnything = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      sawAnything = true
      continue
    }
    if (char === '\r') {
      if (source[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAnything = false
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      sawAnything = false
      continue
    }
    field += char
    sawAnything = true
  }
  if (field !== '' || row.length > 0 || sawAnything) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export interface ImportCsvInput extends ParseCsvOptions {
  sheet: number
  csv: string
  /** Defaults to A1. */
  anchor?: { row: number; column: number }
  /** Write values verbatim instead of letting the engine coerce `1` / `TRUE` / `=1+1`. */
  asText?: boolean
}

export interface ImportCsvResult {
  summary: SpreadsheetBatchSummary
  rowCount: number
  columnCount: number
  range: SpreadsheetSelection | null
}

export function importCsv(model: SpreadsheetEngineModel, input: ImportCsvInput): ImportCsvResult {
  const rows = parseCsv(input.csv, input.delimiter === undefined ? {} : { delimiter: input.delimiter })
  const anchor = input.anchor ?? { row: 1, column: 1 }
  const height = rows.length
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (height === 0 || width === 0) {
    return { summary: summaryOf(null, [input.sheet], 0, []), rowCount: 0, columnCount: 0, range: null }
  }
  const cells = height * width
  if (cells > SPREADSHEET_LIMITS.maxCellsPerWrite) {
    throw tooLarge(`the CSV is ${cells} cells, over the ${SPREADSHEET_LIMITS.maxCellsPerWrite}-cell write limit`)
  }
  const range: SpreadsheetSelection = {
    r0: anchor.row,
    c0: anchor.column,
    r1: anchor.row + height - 1,
    c1: anchor.column + width - 1,
  }
  runPaused(model, () => {
    for (let r = 0; r < height; r++) {
      const row = rows[r] ?? []
      for (let c = 0; c < width; c++) {
        const value = row[c] ?? ''
        // A leading `'` is IronCalc's own quote prefix, so a CSV field that
        // starts with `=` or `+` stays text when the caller asked for text.
        model.setUserInput(input.sheet, anchor.row + r, anchor.column + c, input.asText && value !== '' ? `'${value}` : value)
      }
    }
  })
  return {
    summary: summaryOf(null, [input.sheet], cells, [rectangleOf(input.sheet, range)]),
    rowCount: height,
    columnCount: width,
    range,
  }
}

export interface ExportCsvOptions {
  delimiter?: string
  /** `'\r\n'` for Excel; defaults to `'\n'`. */
  newline?: string
  /** Prefix the output with a UTF-8 BOM so Excel opens it as UTF-8. */
  bom?: boolean
  range?: SpreadsheetSelection
}

function quote(field: string, delimiter: string): string {
  return /["\r\n]/.test(field) || field.includes(delimiter) ? `"${field.replace(/"/g, '""')}"` : field
}

/**
 * One sheet's formatted values as CSV. Hidden rows and columns are exported:
 * the engine carries them as height/width 0 and a filter is a view, not a
 * deletion — the same thing Excel does when you save a filtered sheet as CSV.
 */
export function exportCsv(model: SpreadsheetEngineModel, sheet: number, options: ExportCsvOptions = {}): string {
  const delimiter = options.delimiter ?? ','
  const newline = options.newline ?? '\n'
  const bounds = options.range ?? usedRange(model, sheet)
  if (!bounds) return options.bom ? BOM : ''
  const lines: string[] = []
  for (let row = bounds.r0; row <= bounds.r1; row++) {
    const fields: string[] = []
    for (let column = bounds.c0; column <= bounds.c1; column++) {
      fields.push(quote(model.formattedValue(sheet, row, column) ?? '', delimiter))
    }
    lines.push(fields.join(delimiter))
  }
  return `${options.bom ? BOM : ''}${lines.join(newline)}`
}
