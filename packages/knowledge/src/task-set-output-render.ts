import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import ExcelJS from 'exceljs'
import { TaskSetDisclosureSchema, type TaskSetDisclosure, type TaskSetOutput } from '@nessie/schemas'
import { TaskSetSourceError, taskSetCanonicalJson, taskSetField } from './task-set-records.js'

export type TaskSetArtifactRow = {
  id: string
  sequence: number
  input: unknown
  result: string | null
  disclosure: unknown
}
export type TaskSetArtifactFormat = Exclude<TaskSetOutput, { kind: 'journal' }>

const excelText = (value: unknown): string | number | boolean => {
  const cell = typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
    ? value : taskSetCanonicalJson(value)
  if (typeof cell === 'string' && cell.length > 32_767) {
    throw new TaskSetSourceError('output_too_large', 'A result exceeds Excel cell capacity; choose JSONL output.')
  }
  // Plain strings stay strings, including those beginning with '='. Never manufacture formula objects.
  return cell
}

const spreadsheetValues = (row: TaskSetArtifactRow, output: TaskSetArtifactFormat): unknown[] => {
  if (output.kind !== 'spreadsheet') return []
  const fields = Object.values(output.fields)
  let result: unknown = row.result
  if (fields.length) {
    try { result = JSON.parse(row.result ?? 'null') as unknown } catch {
      throw new TaskSetSourceError('invalid_output', 'Mapped spreadsheet output requires a JSON result.')
    }
  }
  return [row.sequence, row.id, taskSetCanonicalJson(row.input), row.result ?? '',
    ...fields.map((field) => taskSetField(result, field))]
}

/** A streaming writer consumes persisted rows; it never calls a model or mutates the input workbook. */
export const renderTaskSetArtifact = async (
  path: string, output: TaskSetArtifactFormat, rows: AsyncIterable<TaskSetArtifactRow>,
  revalidate: () => Promise<unknown>,
): Promise<{ contentHash: string; disclosure: TaskSetDisclosure; count: number; mime: string; extension: string }> => {
  const digest = createHash('sha256').update(taskSetCanonicalJson(output))
  const scopes = new Map<string, TaskSetDisclosure['basisScopes'][number]>()
  const authors = new Map<string, TaskSetDisclosure['disclosureSources'][number]>()
  let count = 0
  const destination = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  const destinationDone = finished(destination)
  void destinationDone.catch(() => undefined)
  const spreadsheet = output.kind === 'spreadsheet'
    ? new ExcelJS.stream.xlsx.WorkbookWriter({ stream: destination, useSharedStrings: false, useStyles: false }) : null
  const sheet = spreadsheet?.addWorksheet('Results')
  if (sheet && output.kind === 'spreadsheet') {
    sheet.addRow(['Sequence', 'Item ID', 'Source input (JSON)', 'Result', ...Object.keys(output.fields)]).commit()
  }
  const text = spreadsheet ? null : destination
  try {
    for await (const row of rows) {
      if (count % 200 === 0) await revalidate()
      const basis = TaskSetDisclosureSchema.parse(row.disclosure)
      for (const scope of basis.basisScopes) scopes.set(taskSetCanonicalJson(scope), scope)
      for (const author of basis.disclosureSources) authors.set(taskSetCanonicalJson(author), author)
      digest.update(taskSetCanonicalJson({ ...row, disclosure: basis })).update('\n')
      if (sheet) {
        if (count >= 1_048_575) throw new TaskSetSourceError('output_too_large', 'The result exceeds the Excel row limit.')
        sheet.addRow(spreadsheetValues(row, output).map(excelText)).commit()
      } else if (text) {
        const chunk = output.kind === 'documents' && output.format === 'jsonl'
          ? `${taskSetCanonicalJson({ id: row.id, sequence: row.sequence, input: row.input, result: row.result })}\n`
          : `Item ${row.sequence} (${row.id})\n${row.result ?? ''}\n\n`
        if (!text.write(chunk)) await once(text, 'drain')
      }
      count++
    }
    if (spreadsheet) await spreadsheet.commit()
    if (text) text.end()
    await destinationDone
    return {
      contentHash: digest.digest('hex'), count,
      disclosure: { classified: true, basisScopes: [...scopes.values()], disclosureSources: [...authors.values()] },
      mime: spreadsheet ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : output.kind === 'documents' && output.format === 'jsonl' ? 'application/x-ndjson' : 'text/plain; charset=utf-8',
      extension: spreadsheet ? 'xlsx' : output.kind === 'documents' && output.format === 'jsonl' ? 'jsonl' : 'txt',
    }
  } catch (error) {
    destination.destroy()
    await destinationDone.catch(() => undefined)
    throw error
  }
}
