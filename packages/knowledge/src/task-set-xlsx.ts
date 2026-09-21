import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import Unzipper from 'unzipper'
import { TASK_SET_SOURCE_LIMITS, TaskSetSourceError } from './task-set-records.js'

/**
 * ExcelJS 4.4's whole-ZIP reader drops late metadata in multi-sheet archives
 * and leaks its deferred worksheet scratch files when interrupted. Use its
 * pinned XML/cell parser with explicit ZIP-entry ownership instead. This is
 * the only private-library seam; multi-sheet, formula and scale tests guard it.
 */
type EntryParser = {
  model?: { sheets?: Array<{ name: string; rId: string }> }
  workbookRels?: Array<{ Id: string; Target: string }>
  _parseWorkbook: (entry: Readable) => Promise<void>
  _parseRels: (entry: Readable) => Promise<void>
  _parseStyles: (entry: Readable) => Promise<void>
  _parseSharedStrings: (entry: Readable) => AsyncIterable<unknown>
  _parseWorksheet: (entry: Readable, sheetNumber: string) => Iterable<{ value: AsyncIterable<ExcelJS.Row> }>
}

export async function* readTaskSetExcelRows(path: string, selectedSheet: string): AsyncGenerator<ExcelJS.Row> {
  const directory = await Unzipper.Open.file(path)
  const entries = new Map(directory.files.map((entry) => [entry.path, entry]))
  if (entries.size !== directory.files.length) {
    throw new TaskSetSourceError('invalid_input', 'The workbook contains duplicate ZIP entries.')
  }
  let expanded = 0
  const read = async <T>(name: string, consume: (input: Readable) => Promise<T>): Promise<T> => {
    const entry = entries.get(name)
    if (!entry) throw new TaskSetSourceError('invalid_input', `The workbook is missing ${name}.`)
    const raw = entry.stream()
    const input = Readable.from((async function* () {
      for await (const chunk of raw) {
        const bytes = Buffer.from(chunk as Uint8Array)
        expanded += bytes.length
        if (expanded > TASK_SET_SOURCE_LIMITS.bytes) {
          throw new TaskSetSourceError('input_too_large', 'The expanded workbook exceeds the source byte limit.')
        }
        yield bytes
      }
    })())
    try { return await consume(input) } finally { input.destroy(); raw.destroy() }
  }
  const parser = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore',
  }) as unknown as EntryParser
  await read('xl/workbook.xml', (input) => parser._parseWorkbook(input))
  await read('xl/_rels/workbook.xml.rels', (input) => parser._parseRels(input))
  if (entries.has('xl/styles.xml')) await read('xl/styles.xml', (input) => parser._parseStyles(input))
  if (entries.has('xl/sharedStrings.xml')) await read('xl/sharedStrings.xml', async (input) => {
    for await (const ignored of parser._parseSharedStrings(input)) { void ignored }
  })
  const matches = parser.model?.sheets?.filter((sheet) => sheet.name === selectedSheet) ?? []
  if (matches.length !== 1) {
    throw new TaskSetSourceError('invalid_mapping', 'The selected worksheet does not exist or is ambiguous.')
  }
  const target = parser.workbookRels?.find((relation) => relation.Id === matches[0]?.rId)?.Target
  const number = target?.match(/^worksheets\/sheet(\d+)\.xml$/)?.[1]
  if (!target || !number) {
    throw new TaskSetSourceError('invalid_input', 'The selected worksheet has an unsupported file relationship.')
  }
  // The row iterator lives outside a callback so backpressure reaches the ZIP
  // inflater. All streams close when the caller returns after any chosen row.
  const entry = entries.get(`xl/${target}`)
  if (!entry) throw new TaskSetSourceError('invalid_input', 'The selected worksheet XML is missing.')
  const raw = entry.stream()
  const input = Readable.from((async function* () {
    for await (const chunk of raw) {
      const bytes = Buffer.from(chunk as Uint8Array)
      expanded += bytes.length
      if (expanded > TASK_SET_SOURCE_LIMITS.bytes) {
        throw new TaskSetSourceError('input_too_large', 'The expanded workbook exceeds the source byte limit.')
      }
      yield bytes
    }
  })())
  try {
    const sheet = parser._parseWorksheet(input, number)[Symbol.iterator]().next().value
    if (!sheet) throw new TaskSetSourceError('invalid_input', 'The selected worksheet could not be read.')
    yield* sheet.value
  } finally { input.destroy(); raw.destroy() }
}
