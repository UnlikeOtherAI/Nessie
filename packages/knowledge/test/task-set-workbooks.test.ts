import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import type { TaskSetSource } from '@nessie/schemas'
import { parseTaskSetSource } from '../src/task-set-sources.js'
import { taskSetMapInput, type TaskSetSourceRecord } from '../src/task-set-records.js'

const source = (format: TaskSetSource['format'], selection: TaskSetSource['selection']): TaskSetSource => ({
  kind: 'document', pageId: '00000000-0000-4000-8000-000000000001',
  versionId: '00000000-0000-4000-8000-000000000002', format, selection,
})
const collect = async (values: AsyncIterable<TaskSetSourceRecord>): Promise<TaskSetSourceRecord[]> => {
  const records: TaskSetSourceRecord[] = []
  for await (const record of values) records.push(record)
  return records
}

test('XLSX selects the named sheet, preserves row gaps/formulas, and maps header names or column indices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-task-xlsx-test-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'source.xlsx')
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Other').addRow(['wrong'])
  const sheet = workbook.addWorksheet('Data')
  sheet.addRow(['id', 'name', 'calculated'])
  sheet.addRow([125, 'Ondřej', { formula: '1+1', result: 2 }])
  sheet.getCell('A4').value = 127
  sheet.getCell('B4').value = 'final'
  await workbook.xlsx.writeFile(file)
  const selection = { sheet: 'Data', headerRow: 1, fields: { number: 1, label: 'name' } }
  const rows = await collect(parseTaskSetSource(createReadStream(file), source('xlsx', selection)))
  assert.deepEqual(rows.map((row) => row.ordinal), [2, 3, 4])
  assert.deepEqual(rows[0]?.value, { id: 125, name: 'Ondřej', calculated: { formula: '1+1', value: 2 } })
  assert.deepEqual(taskSetMapInput(rows[0]?.value, source('xlsx', selection), rows[0]?.columns),
    { number: 125, label: 'Ondřej' })
  assert.deepEqual(rows[1]?.value, { id: null, name: null, calculated: null })
  const interrupted = parseTaskSetSource(createReadStream(file), source('xlsx', selection))
  assert.equal((await interrupted.next()).value?.ordinal, 2)
  await interrupted.return(undefined)
  assert.deepEqual(await collect(parseTaskSetSource(createReadStream(file), source('xlsx', selection))), rows)
  await assert.rejects(collect(parseTaskSetSource(createReadStream(file), source('xlsx', { sheet: 'Missing' }))),
    /does not exist/)
})

test('XLSX with 80,000 rows is iterated without materializing an array of workbook records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-task-xlsx-scale-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'source.xlsx')
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: false })
  const sheet = workbook.addWorksheet('Data')
  sheet.addRow(['id', 'name']).commit()
  for (let id = 1; id <= 80_000; id++) sheet.addRow([id, `Item ${id}`]).commit()
  await workbook.commit()
  let count = 0
  for await (const record of parseTaskSetSource(createReadStream(file),
    source('xlsx', { sheet: 'Data', headerRow: 1 }))) {
    count++
    assert.equal(record.ordinal, count + 1)
    assert.deepEqual(record.value, { id: count, name: `Item ${count}` })
  }
  assert.equal(count, 80_000)
})

type SqliteForTest = {
  DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void }
}

test('SQLite reads immutable ordinary tables in deterministic key order, including WITHOUT ROWID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-task-sqlite-test-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, 'source.db')
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as SqliteForTest
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE records (id INTEGER, name TEXT);
    INSERT INTO records VALUES (20, 'first'), (10, 'second');
    CREATE TABLE keyed (part TEXT, id INTEGER, payload TEXT, PRIMARY KEY(part,id)) WITHOUT ROWID;
    INSERT INTO keyed VALUES ('b', 1, 'third'), ('a', 2, 'second'), ('a', 1, 'first');
    CREATE VIEW dangerous AS SELECT load_extension('not-allowed');
    CREATE TABLE shadows (rowid TEXT, _rowid_ TEXT, oid TEXT);
  `)
  db.close()
  const plain = await collect(parseTaskSetSource(createReadStream(file), source('sqlite', { table: 'records' })))
  assert.deepEqual(plain.map((row) => row.value), [{ id: '20', name: 'first' }, { id: '10', name: 'second' }])
  const keyed = await collect(parseTaskSetSource(createReadStream(file), source('sqlite', { table: 'keyed' })))
  assert.deepEqual(keyed.map((row) => (row.value as { payload: string }).payload), ['first', 'second', 'third'])
  assert.deepEqual(keyed.map((row) => row.locator), ['keyed:["a","1"]', 'keyed:["a","2"]', 'keyed:["b","1"]'])
  for (const table of ['dangerous', 'shadows', "records; DROP TABLE keyed"]) {
    await assert.rejects(collect(parseTaskSetSource(createReadStream(file), source('sqlite', { table }))))
  }
  const replay = await collect(parseTaskSetSource(createReadStream(file), source('sqlite', { table: 'keyed' })))
  assert.deepEqual(replay, keyed)
})
