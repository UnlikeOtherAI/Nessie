import { Readable } from 'node:stream'
import type { FileService } from '@nessie/runtime'
import {
  TaskSetDisclosureSchema, TaskSetSourceSchema,
  type TaskSetDisclosure, type TaskSetImportedItem, type TaskSetSource,
} from '@nessie/schemas'
import { taskSetDelimitedRecords } from './task-set-csv.js'
import { taskSetJsonLinesRecords, taskSetJsonRecords } from './task-set-json.js'
import { taskSetExcelRecords, taskSetSqliteRecords } from './task-set-workbooks.js'
import {
  TASK_SET_SOURCE_LIMITS, TaskSetSourceError, taskSetCanonicalJson, taskSetField, taskSetHash,
  taskSetMapInput, type TaskSetSourceRecord,
} from './task-set-records.js'
import type { TaskSetResolvedSource } from './task-set-access.js'

export type TaskSetConsumedSourceSink = {
  add: (scope: TaskSetDisclosure['basisScopes'][number]) => void
  addPrivateConversationSource: (source: TaskSetDisclosure['disclosureSources'][number]) => void
}

export const consumeTaskSetDisclosure = (sink: TaskSetConsumedSourceSink, value: unknown): TaskSetDisclosure => {
  const disclosure = TaskSetDisclosureSchema.parse(value)
  for (const scope of disclosure.basisScopes) sink.add(scope)
  for (const source of disclosure.disclosureSources) sink.addPrivateConversationSource(source)
  return disclosure
}

/** Low-level deterministic parser. Its caller owns the authorized FileService stream. */
export async function* parseTaskSetSource(
  input: Readable, source: TaskSetSource,
): AsyncGenerator<TaskSetSourceRecord> {
  TaskSetSourceSchema.parse(source)
  if ((source.selection.lastRow ?? Infinity) < (source.selection.firstRow ?? 1)) {
    throw new TaskSetSourceError('invalid_mapping', 'The selected end row precedes the first row.')
  }
  const stream = Readable.from((async function* () {
    let total = 0
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk as Uint8Array)
      total += bytes.length
      if (total > TASK_SET_SOURCE_LIMITS.bytes) {
        throw new TaskSetSourceError('input_too_large', 'The source exceeds the importer byte limit.')
      }
      yield bytes
    }
  })())
  try {
    const records = source.format === 'csv' || source.format === 'tsv' ? taskSetDelimitedRecords(stream, source)
      : source.format === 'json' ? taskSetJsonRecords(stream, source)
        : source.format === 'jsonl' ? taskSetJsonLinesRecords(stream)
          : source.format === 'xlsx' ? taskSetExcelRecords(stream, source) : taskSetSqliteRecords(stream, source)
    for await (const record of records) {
      if (record.ordinal < (source.selection.firstRow ?? 1)) continue
      if (record.ordinal > (source.selection.lastRow ?? Infinity)) continue
      yield record
    }
  } finally { stream.destroy(); input.destroy() }
}

export type TaskSetSourceDeps = {
  fileService: Pick<FileService, 'openStream'>
  organizationId: string
  /** Resolve fresh authority with resolveTaskSetDocumentSource; never a cached boolean. */
  authorize: () => Promise<TaskSetResolvedSource>
  consumedSources?: TaskSetConsumedSourceSink
}

/** Restart re-reads immutable bytes and skips admitted ordinals; the core persists each bounded page. */
export async function* iterateTaskSetSource(
  deps: TaskSetSourceDeps,
  options: { source: TaskSetSource; afterOrdinal?: number },
): AsyncGenerator<TaskSetImportedItem> {
  const { source } = options
  const initial = await deps.authorize()
  let disclosure = TaskSetDisclosureSchema.parse(initial.disclosure)
  const opened = await deps.fileService.openStream(initial.attachmentId, deps.organizationId)
  if (!opened) throw new TaskSetSourceError('source_unavailable', 'The pinned source bytes are unavailable.')
  if (Number(opened.attachment.sizeBytes) > TASK_SET_SOURCE_LIMITS.bytes) {
    opened.stream.destroy()
    throw new TaskSetSourceError('input_too_large', 'The source exceeds the importer byte limit.')
  }
  let emitted = 0
  for await (const record of parseTaskSetSource(opened.stream, source)) {
    if (record.ordinal <= (options.afterOrdinal ?? 0)) continue
    if (emitted % TASK_SET_SOURCE_LIMITS.pageSize === 0) {
      const fresh = await deps.authorize()
      if (fresh.attachmentId !== initial.attachmentId) {
        throw new TaskSetSourceError('source_changed', 'The pinned version no longer identifies the same source bytes.')
      }
      disclosure = TaskSetDisclosureSchema.parse(fresh.disclosure)
    }
    if (deps.consumedSources) consumeTaskSetDisclosure(deps.consumedSources, disclosure)
    let input: unknown
    try { input = taskSetMapInput(record.value, source, record.columns) } catch (error) {
      if (error instanceof TaskSetSourceError) throw new TaskSetSourceError(error.code, error.message, record.locator)
      throw error
    }
    const sourceKey = source.selection.keyField === undefined ? null
      : taskSetField(record.value, source.selection.keyField)
    const locator = sourceKey === null ? record.locator : `${record.locator};key=${taskSetCanonicalJson(sourceKey)}`
    yield {
      ordinal: record.ordinal,
      key: taskSetHash(taskSetCanonicalJson([source.pageId, source.versionId, source.selection.sheet ?? null,
        source.selection.table ?? null, source.selection.recordPath ?? null, record.ordinal])),
      input, inputHash: taskSetHash(taskSetCanonicalJson(input)), sourceLocator: locator, disclosure,
    }
    emitted++
  }
}
