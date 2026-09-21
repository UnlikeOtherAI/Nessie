import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import type { TaskSetSource } from '@nessie/schemas'
import {
  TASK_SET_SOURCE_LIMITS, TaskSetSourceError, taskSetHeaders, taskSetTableRecord,
  type TaskSetSourceRecord,
} from './task-set-records.js'

/** RFC 4180 records, preserving quoted newlines and empty rows across chunk boundaries. */
export async function* taskSetDelimitedRecords(
  stream: Readable, source: TaskSetSource,
): AsyncGenerator<TaskSetSourceRecord> {
  const delimiter = source.format === 'tsv' ? '\t' : ','
  const decoder = new StringDecoder('utf8')
  let ordinal = 0
  let row: string[] = []
  let cell = ''
  let mode: 'start' | 'plain' | 'quoted' | 'closed' = 'start'
  let skipLf = false
  let first = true
  let recordBytes = 0
  let headers: string[] | null = null
  let touched = false
  const headerRow = source.selection.headerRow

  const finish = (): TaskSetSourceRecord | null => {
    ordinal++
    row.push(cell)
    const values = row
    row = []
    cell = ''
    mode = 'start'
    recordBytes = 0
    touched = false
    if (ordinal === headerRow) {
      headers = taskSetHeaders(values)
      return null
    }
    if (headerRow && ordinal < headerRow) return null
    return { ordinal, value: taskSetTableRecord(values, headers, `row:${ordinal}`),
      columns: values, locator: `row:${ordinal}` }
  }

  async function* chunks(): AsyncGenerator<string> {
    for await (const chunk of stream) yield decoder.write(Buffer.from(chunk as Uint8Array))
    const tail = decoder.end()
    if (tail) yield tail
  }
  for await (const chunk of chunks()) {
    for (const character of chunk) {
      if (first) { first = false; if (character === '\uFEFF') continue }
      if (skipLf) { skipLf = false; if (character === '\n') continue }
      recordBytes += Buffer.byteLength(character)
      if (recordBytes > TASK_SET_SOURCE_LIMITS.recordBytes) {
        throw new TaskSetSourceError('input_too_large', 'The delimited record exceeds the byte limit.', `row:${ordinal + 1}`)
      }
      touched = true
      if (mode === 'quoted') {
        if (character === '"') mode = 'closed'
        else cell += character
        continue
      }
      if (mode === 'closed' && character === '"') { cell += '"'; mode = 'quoted'; continue }
      if (character === delimiter) {
        row.push(cell); cell = ''; mode = 'start'
        if (row.length >= TASK_SET_SOURCE_LIMITS.columns) {
          throw new TaskSetSourceError('input_too_large', 'The record has too many columns.', `row:${ordinal + 1}`)
        }
      } else if (character === '\r' || character === '\n') {
        const record = finish()
        if (record) yield record
        skipLf = character === '\r'
      } else if (mode === 'closed') {
        throw new TaskSetSourceError('invalid_input', 'Unexpected data after a quoted field.', `row:${ordinal + 1}`)
      } else if (character === '"') {
        if (mode !== 'start') {
          throw new TaskSetSourceError('invalid_input', 'A quote occurs inside an unquoted field.', `row:${ordinal + 1}`)
        }
        mode = 'quoted'
      } else { cell += character; mode = 'plain' }
    }
  }
  if (mode === 'quoted') throw new TaskSetSourceError('invalid_input', 'The final quoted field is not closed.')
  if (touched) { const record = finish(); if (record) yield record }
  if (headerRow && ordinal < headerRow) throw new TaskSetSourceError('invalid_mapping', 'The header row does not exist.')
}
