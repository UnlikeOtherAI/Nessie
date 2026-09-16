import { columnIndexToLabel } from '@nessie/schemas'

import type { SpreadsheetEngineModel } from './engine.js'
import { usedRange } from './read.js'

// The plain-text projection that becomes `KnowledgePageVersion.body`, which is
// what `indexVersionChunks` chunks and embeds and what every knowledge search
// actually matches against. Two properties matter more than prettiness:
//
//  - **Deterministic.** The same workbook projects to the same bytes, on either
//    binding, in any process. It is derived only from sheet order, the used
//    range and formatted values — never from `toBytes()`, which is not
//    byte-deterministic at all (decisions.md §"Spike A").
//  - **Searchable.** A person looking for "Q3 revenue" should hit the row that
//    says it, so the column header line is emitted with the rows under it and
//    values are tab-separated rather than aligned.

export interface ProjectionOptions {
  /** Stop after this many characters and say so. Defaults to 2 MB. */
  maxChars?: number
  /** Stop after this many rows per sheet. Defaults to 50 000. */
  maxRowsPerSheet?: number
  /** Include a `# <title>` line above the sheets. */
  title?: string
}

const DEFAULT_MAX_CHARS = 2_000_000
const DEFAULT_MAX_ROWS = 50_000

function escapeCell(text: string): string {
  // Tabs and newlines inside a value would forge a row boundary in the
  // projection, so they collapse to a space. Nothing else is touched.
  return text.replace(/[\t\r\n]+/g, ' ')
}

/** A deterministic plain-text rendering of the whole workbook. */
export function projectWorkbook(model: SpreadsheetEngineModel, options: ProjectionOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxRows = options.maxRowsPerSheet ?? DEFAULT_MAX_ROWS
  const lines: string[] = []
  let length = 0
  let truncated = false

  const push = (line: string): boolean => {
    if (length + line.length + 1 > maxChars) {
      truncated = true
      return false
    }
    lines.push(line)
    length += line.length + 1
    return true
  }

  if (options.title) {
    push(`# ${escapeCell(options.title)}`)
    push('')
  }

  const sheets = model.sheets()
  for (let sheet = 0; sheet < sheets.length && !truncated; sheet++) {
    const properties = sheets[sheet]!
    const hidden = (properties.state ?? 'visible') !== 'visible'
    if (!push(`## ${escapeCell(properties.name)}${hidden ? ' (hidden)' : ''}`)) break
    const used = usedRange(model, sheet)
    if (!used) {
      push('(empty)')
      push('')
      continue
    }
    const columns: string[] = []
    for (let column = used.c0; column <= used.c1; column++) columns.push(columnIndexToLabel(column))
    if (!push(columns.join('\t'))) break
    const lastRow = Math.min(used.r1, used.r0 + maxRows - 1)
    for (let row = used.r0; row <= lastRow; row++) {
      const cells: string[] = []
      let anything = false
      for (let column = used.c0; column <= used.c1; column++) {
        const value = escapeCell(model.formattedValue(sheet, row, column) ?? '')
        if (value !== '') anything = true
        cells.push(value)
      }
      if (!anything) continue
      // Trailing empties carry no information and would make the projection
      // depend on the used range's width rather than on the row itself.
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
      if (!push(cells.join('\t'))) break
    }
    if (lastRow < used.r1) push(`(${used.r1 - lastRow} more row(s) not shown)`)
    push('')
  }

  if (truncated) lines.push('(projection truncated)')
  // A trailing blank line would make the output depend on how the last sheet
  // ended rather than on its content.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** One sheet only — what a per-sheet tool answer or a preview wants. */
export function projectSheet(
  model: SpreadsheetEngineModel,
  sheet: number,
  options: ProjectionOptions = {},
): string {
  const used = usedRange(model, sheet)
  const name = model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`
  if (!used) return `## ${escapeCell(name)}\n(empty)`
  const single: SpreadsheetEngineModel = {
    ...model,
    sheets: () => [model.sheets()[sheet] ?? { name }],
    dimensions: () => model.dimensions(sheet),
    cellContent: (_s, r, c) => model.cellContent(sheet, r, c),
    formattedValue: (_s, r, c) => model.formattedValue(sheet, r, c),
    cellType: (_s, r, c) => model.cellType(sheet, r, c),
  }
  return projectWorkbook(single, options)
}
