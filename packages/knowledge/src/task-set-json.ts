import { StringDecoder } from 'node:string_decoder'
import { PassThrough, Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/Pick.js'
import { streamArray } from 'stream-json/streamers/StreamArray.js'
import { streamValues } from 'stream-json/streamers/StreamValues.js'
import type { TaskSetSource } from '@nessie/schemas'
import { TASK_SET_SOURCE_LIMITS, TaskSetSourceError, type TaskSetSourceRecord } from './task-set-records.js'

type JsonToken = { name: string; value?: string }

/** Limits a selected JSON record before the assembler retains an oversized value. */
const recordBudget = (): Transform => {
  let depth = 0
  let array = false
  let first = true
  let bytes = 0
  return new Transform({
    objectMode: true,
    transform(token: JsonToken, _encoding, callback) {
      if (first) { array = token.name === 'startArray'; first = false }
      bytes += token.name.endsWith('Chunk') ? Buffer.byteLength(token.value ?? '') : 1
      if (token.name === 'startObject' || token.name === 'startArray') depth++
      if (depth > TASK_SET_SOURCE_LIMITS.depth || bytes > TASK_SET_SOURCE_LIMITS.recordBytes) {
        callback(new TaskSetSourceError('input_too_large', 'The JSON record exceeds the byte or depth limit.'))
        return
      }
      if (token.name === 'endObject' || token.name === 'endArray') depth--
      if (array && depth === 1 && (
        token.name === 'endObject' || token.name === 'endArray' || token.name.endsWith('Value')
      )) bytes = 0
      callback(null, token)
    },
  })
}

export async function* taskSetJsonRecords(
  stream: Readable, source: TaskSetSource,
): AsyncGenerator<TaskSetSourceRecord> {
  const tokens = new PassThrough({ objectMode: true, highWaterMark: 8 })
  const path = source.selection.recordPath
  const parts = path?.startsWith('/')
    ? path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    : path ? [path] : null
  const selected = parts ? pick({
    filter: (stack: (string | number)[]) => stack.length === parts.length
      && stack.every((part, index) => String(part) === parts[index]),
    once: true,
  }) : new PassThrough({ objectMode: true })
  const reading = pipeline(stream, parser(), selected, recordBudget(), tokens)
  // The iterator observes this same failure; attach immediately so a fast parser cannot reject unhandled.
  void reading.catch(() => undefined)
  const iterator = tokens[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    await reading
    throw new TaskSetSourceError('invalid_mapping', 'The JSON record path did not select a value.')
  }
  const remainder = Readable.from((async function* () {
    yield first.value as JsonToken
    for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value as JsonToken }
  })())
  const assembled = (first.value as JsonToken).name === 'startArray' ? streamArray() : streamValues()
  const assembling = pipeline(remainder, assembled)
  void assembling.catch(() => undefined)
  let ordinal = 0
  try {
    for await (const item of assembled) {
      ordinal++
      yield { ordinal, value: (item as { value: unknown }).value, locator: `record:${ordinal}` }
    }
    await assembling
    await reading
  } finally {
    stream.destroy()
    remainder.destroy()
    tokens.destroy()
    await Promise.allSettled([reading, assembling])
  }
}

export async function* taskSetJsonLinesRecords(stream: Readable): AsyncGenerator<TaskSetSourceRecord> {
  const decoder = new StringDecoder('utf8')
  let line = ''
  let ordinal = 0
  const record = (): TaskSetSourceRecord => {
    ordinal++
    const text = ordinal === 1 ? line.replace(/^\uFEFF/, '') : line
    line = ''
    if (!text.trim()) throw new TaskSetSourceError('invalid_input', 'An empty JSONL record is invalid.', `line:${ordinal}`)
    try { return { ordinal, value: JSON.parse(text) as unknown, locator: `line:${ordinal}` } } catch {
      throw new TaskSetSourceError('invalid_input', 'The JSONL record is not valid JSON.', `line:${ordinal}`)
    }
  }
  for await (const chunk of stream) {
    const text = decoder.write(Buffer.from(chunk as Uint8Array))
    for (const character of text) {
      if (character === '\n') yield record()
      else line += character
      if (Buffer.byteLength(line) > TASK_SET_SOURCE_LIMITS.recordBytes) {
        throw new TaskSetSourceError('input_too_large', 'The JSONL record exceeds the byte limit.', `line:${ordinal + 1}`)
      }
    }
  }
  line += decoder.end()
  if (line) yield record()
}
