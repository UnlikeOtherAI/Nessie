import { createHash } from 'node:crypto'

import type { SpreadsheetEngineModel } from './engine.js'

// The convergence oracle. `toBytes()` is NOT byte-deterministic — two models
// built by the same binding with the same calls in the same order serialise
// differently, because a hash-map iteration order reaches the wire — so every
// "same workbook" assertion and every content hash goes through this projection
// instead. See decisions.md §"Spike A".

export interface CanonicalOptions {
  /** Guards a runaway scan; a sheet wider or taller is truncated and flagged. */
  maxCellsPerSheet?: number
}

const STYLE_KEYS = ['num_fmt', 'font', 'fill', 'border', 'alignment', 'quote_prefix'] as const

function stableStyle(style: unknown): string {
  if (!style || typeof style !== 'object') return ''
  const source = style as Record<string, unknown>
  const parts: string[] = []
  for (const key of STYLE_KEYS) {
    const value = source[key]
    if (value === undefined || value === null) continue
    parts.push(`${key}=${JSON.stringify(value, Object.keys(value as object).sort())}`)
  }
  return parts.join(';')
}

/** A deterministic, order-independent text projection of a whole workbook. */
export function canonicalWorkbook(model: SpreadsheetEngineModel, options: CanonicalOptions = {}): string {
  const maxCells = options.maxCellsPerSheet ?? 1_000_000
  const lines: string[] = []
  const sheets = model.sheets()
  for (let sheet = 0; sheet < sheets.length; sheet++) {
    const properties = sheets[sheet]!
    lines.push(
      `sheet ${sheet} name=${properties.name} state=${properties.state ?? 'visible'} color=${properties.color ?? ''} frozen=${model.frozenRowsCount(sheet)},${model.frozenColumnsCount(sheet)}`,
    )
    const [minRow, minColumn, maxRow, maxColumn] = model.dimensions(sheet)
    let seen = 0
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const content = model.cellContent(sheet, row, column)
        if (content === '' || content == null) continue
        if (++seen > maxCells) {
          lines.push(`sheet ${sheet} TRUNCATED after ${maxCells} cells`)
          row = maxRow
          break
        }
        lines.push(
          `${sheet}!${row},${column} content=${content} value=${model.formattedValue(sheet, row, column)} type=${model.cellType(sheet, row, column)} style=${stableStyle(model.cellStyle(sheet, row, column))}`,
        )
      }
    }
  }
  return lines.join('\n')
}

/** Content identity for version rows: stable across engines, processes and
 *  serialisations, unlike a hash of `toBytes()`. */
export function canonicalHash(model: SpreadsheetEngineModel, options?: CanonicalOptions): string {
  return createHash('sha256').update(canonicalWorkbook(model, options)).digest('hex')
}

export function assertSameWorkbook(
  a: SpreadsheetEngineModel,
  b: SpreadsheetEngineModel,
  options?: CanonicalOptions,
): void {
  const left = canonicalWorkbook(a, options)
  const right = canonicalWorkbook(b, options)
  if (left === right) return
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  const differences: string[] = []
  for (let i = 0; i < Math.max(leftLines.length, rightLines.length) && differences.length < 10; i++) {
    if (leftLines[i] !== rightLines[i]) differences.push(`  a: ${leftLines[i] ?? '<none>'}\n  b: ${rightLines[i] ?? '<none>'}`)
  }
  throw new Error(
    `workbooks diverged (${a.binding} vs ${b.binding}, ${leftLines.length} vs ${rightLines.length} lines):\n${differences.join('\n')}`,
  )
}
