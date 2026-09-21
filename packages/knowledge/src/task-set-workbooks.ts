import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ExcelJS from 'exceljs'
import type { TaskSetSource } from '@nessie/schemas'
import {
  TASK_SET_SOURCE_LIMITS, TaskSetSourceError, taskSetHeaders, taskSetTableRecord,
  type TaskSetSourceRecord,
} from './task-set-records.js'

/** Scratch copies are disposable and outside all checkouts; FileService owns the durable bytes. */
async function* withSourceFile(
  stream: Readable, read: (path: string) => AsyncGenerator<TaskSetSourceRecord>,
): AsyncGenerator<TaskSetSourceRecord> {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-task-source-'))
  try {
    const path = join(directory, 'source')
    await pipeline(stream, createWriteStream(path, { mode: 0o600, flags: 'wx' }))
    yield* read(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Read only ZIP metadata, never buffer the source workbook. Refuse ZIP64 and encrypted entries. */
const assertWorkbookBudget = async (path: string): Promise<void> => {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const tail = Buffer.alloc(Math.min(size, 65_557))
    await file.read(tail, 0, tail.length, size - tail.length)
    let end = tail.length - 22
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--
    if (end < 0) throw new TaskSetSourceError('invalid_input', 'The source is not an XLSX ZIP workbook.')
    const count = tail.readUInt16LE(end + 10)
    const length = tail.readUInt32LE(end + 12)
    const offset = tail.readUInt32LE(end + 16)
    if (count === 0xffff || count > 10_000 || length > 4 * 1024 * 1024 || offset + length > size) {
      throw new TaskSetSourceError('input_too_large', 'The workbook ZIP directory exceeds the supported limits.')
    }
    const directory = Buffer.alloc(length)
    const { bytesRead } = await file.read(directory, 0, length, offset)
    if (bytesRead !== length) throw new TaskSetSourceError('invalid_input', 'The workbook ZIP directory is incomplete.')
    let cursor = 0
    let expanded = 0
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new TaskSetSourceError('invalid_input', 'The workbook ZIP directory is invalid.')
      }
      if ((directory.readUInt16LE(cursor + 8) & 1) !== 0) {
        throw new TaskSetSourceError('invalid_input', 'Encrypted workbooks are not supported.')
      }
      expanded += directory.readUInt32LE(cursor + 24)
      if (expanded > TASK_SET_SOURCE_LIMITS.bytes) {
        throw new TaskSetSourceError('input_too_large', 'The expanded workbook exceeds the source byte limit.')
      }
      cursor += 46 + directory.readUInt16LE(cursor + 28)
        + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32)
    }
    if (cursor !== length) throw new TaskSetSourceError('invalid_input', 'The workbook ZIP directory is inconsistent.')
  } finally { await file.close() }
}

const excelValue = (cell: ExcelJS.Cell): unknown => {
  const value = cell.value
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result === undefined) {
      throw new TaskSetSourceError('invalid_input', 'A formula has no cached result; recalculate and save the source workbook.')
    }
    return { formula: cell.formula, value: value.result }
  }
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('hyperlink' in value) return { text: value.text, hyperlink: value.hyperlink }
  if ('error' in value) throw new TaskSetSourceError('invalid_input', `The source contains an Excel error (${value.error}).`)
  throw new TaskSetSourceError('invalid_input', 'The source contains an unsupported Excel cell value.')
}

export async function* taskSetExcelRecords(
  stream: Readable, source: TaskSetSource,
): AsyncGenerator<TaskSetSourceRecord> {
  const selectedSheet = source.selection.sheet
  if (!selectedSheet) throw new TaskSetSourceError('invalid_mapping', 'Choose the source worksheet explicitly.')
  yield* withSourceFile(stream, async function* (path) {
    await assertWorkbookBudget(path)
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(createReadStream(path), {
      worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore',
    })
    let found = false
    for await (const sheet of reader) {
      // ExcelJS 4.4 sets name in WorkbookReader._parseWorksheet but omits it in its declarations.
      if ((sheet as typeof sheet & { name: string }).name !== selectedSheet) continue
      found = true
      let headers: string[] | null = null
      const headerRow = source.selection.headerRow
      let lastRow = 0
      for await (const row of sheet) {
        for (let blank = lastRow + 1; blank < row.number; blank++) {
          if (headerRow && blank <= headerRow) continue
          const locator = `${selectedSheet}!${blank}`
          const values = headers ? headers.map(() => null) : []
          yield { ordinal: blank, value: taskSetTableRecord(values, headers, locator), columns: values, locator }
        }
        lastRow = row.number
        if (row.cellCount > TASK_SET_SOURCE_LIMITS.columns) {
          throw new TaskSetSourceError('input_too_large', 'The source worksheet has too many columns.')
        }
        const values = Array.from({ length: row.cellCount }, (_, index) => excelValue(row.getCell(index + 1)))
        if (row.number === headerRow) { headers = taskSetHeaders(values); continue }
        if (headerRow && row.number < headerRow) continue
        const locator = `${selectedSheet}!${row.number}`
        yield { ordinal: row.number, value: taskSetTableRecord(values, headers, locator), columns: values, locator }
      }
      if (headerRow && (!headers || lastRow < headerRow)) {
        throw new TaskSetSourceError('invalid_mapping', 'The selected worksheet header does not exist.')
      }
    }
    if (!found) throw new TaskSetSourceError('invalid_mapping', 'The selected worksheet does not exist.')
  })
}

type SqlValue = string | number | bigint | null | Uint8Array
type Statement = {
  all(...parameters: SqlValue[]): Record<string, SqlValue>[]
  iterate(...parameters: SqlValue[]): IterableIterator<Record<string, SqlValue>>
  setReadBigInts(value: boolean): void
}
type Database = { prepare(sql: string): Statement; exec(sql: string): void; close(): void }
type Sqlite = { DatabaseSync: new (path: string, options: { readOnly: boolean; allowExtension: boolean }) => Database }

const quoteSqlIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`
const jsonSqlValue = (value: SqlValue): unknown => {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return { encoding: 'base64', data: Buffer.from(value).toString('base64') }
  return value
}

export async function* taskSetSqliteRecords(
  stream: Readable, source: TaskSetSource,
): AsyncGenerator<TaskSetSourceRecord> {
  const table = source.selection.table
  if (!table) throw new TaskSetSourceError('invalid_mapping', 'Choose the SQLite source table explicitly.')
  yield* withSourceFile(stream, async function* (path) {
    // Node 22.13+ supplies this runtime. The narrow type keeps Node-20 declaration packages usable.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as Sqlite
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF')
      const tables = db.prepare('PRAGMA table_list').all()
      const selected = tables.find((entry) => entry.name === table && entry.schema === 'main')
      if (!selected || selected.type !== 'table' || table.startsWith('sqlite_')) {
        throw new TaskSetSourceError('invalid_mapping', 'Choose an ordinary SQLite table; views and virtual tables are unsupported.')
      }
      const columns = db.prepare(`PRAGMA table_xinfo(${quoteSqlIdentifier(table)})`).all()
      if (!columns.length || columns.length > TASK_SET_SOURCE_LIMITS.columns) {
        throw new TaskSetSourceError('input_too_large', 'The SQLite table column count exceeds the supported limit.')
      }
      if (columns.some((column) => Number(column.hidden) !== 0)) {
        throw new TaskSetSourceError('invalid_mapping', 'Generated and hidden SQLite columns are unsupported.')
      }
      const names = columns.map((column) => String(column.name))
      const primary = columns.filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk)).map((column) => String(column.name))
      const rowid = ['_rowid_', 'rowid', 'oid'].find((candidate) => !names.some((name) =>
        name.toLowerCase() === candidate))
      if (!primary.length && (!rowid || Number(selected.wr) !== 0)) {
        throw new TaskSetSourceError('invalid_mapping', 'The SQLite table needs an unambiguous primary key or rowid.')
      }
      if (Number(selected.wr) === 0 && !rowid && columns.some((column) =>
        Number(column.pk) > 0 && Number(column.notnull) === 0
          && !(primary.length === 1 && String(column.type).toUpperCase() === 'INTEGER'))) {
        throw new TaskSetSourceError('invalid_mapping', 'A nullable primary key needs an accessible rowid for stable order.')
      }
      const order = primary.map(quoteSqlIdentifier)
      if (Number(selected.wr) === 0 && rowid) order.push(quoteSqlIdentifier(rowid))
      const statement = db.prepare(
        `SELECT ${names.map(quoteSqlIdentifier).join(',')} FROM ${quoteSqlIdentifier(table)} ORDER BY ${order.join(',')}`,
      )
      statement.setReadBigInts(true)
      let ordinal = 0
      for (const row of statement.iterate()) {
        ordinal++
        const value = Object.fromEntries(names.map((name) => [name, jsonSqlValue(row[name] ?? null)]))
        const identity = primary.length ? JSON.stringify(primary.map((name) => value[name])) : String(ordinal)
        yield { ordinal, value, columns: names.map((name) => value[name]), locator: `${table}:${identity}` }
      }
    } finally { db.close() }
  })
}
