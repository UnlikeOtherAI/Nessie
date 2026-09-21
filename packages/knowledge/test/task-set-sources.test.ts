import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import type { FileService } from '@nessie/runtime'
import type { TaskSetDisclosure, TaskSetImportedItem, TaskSetSource } from '@nessie/schemas'
import { iterateTaskSetSource, parseTaskSetSource } from '../src/task-set-sources.js'
import { TaskSetSourceError, taskSetMapInput } from '../src/task-set-records.js'

const PAGE = '00000000-0000-4000-8000-000000000001'
const VERSION = '00000000-0000-4000-8000-000000000002'
const PRIVATE_CHANNEL = '00000000-0000-4000-8000-000000000003'
const AUTHOR = '00000000-0000-4000-8000-000000000004'
const source = (format: TaskSetSource['format'], selection: TaskSetSource['selection'] = {}): TaskSetSource => ({
  kind: 'document', pageId: PAGE, versionId: VERSION, format, selection,
})
const disclosure: TaskSetDisclosure = {
  classified: true,
  basisScopes: [{ scopeType: 'channel', scopeId: PRIVATE_CHANNEL }],
  disclosureSources: [{ sourceChannelId: PRIVATE_CHANNEL, sourceAuthorUserId: AUTHOR }],
}
const collect = async <T>(items: AsyncIterable<T>): Promise<T[]> => {
  const rows: T[] = []
  for await (const row of items) rows.push(row)
  return rows
}
const chunks = (text: string): Readable => Readable.from([...Buffer.from(text)].map((byte) => Buffer.from([byte])))

test('CSV preserves source row ordinals, UTF-8, empty rows and quoted newlines across every byte boundary', async () => {
  const rows = await collect(parseTaskSetSource(
    chunks('\uFEFFname,note\r\nOndřej,"first\r\nsecond ""quoted"""\r\n,\r\nZoe,end'),
    source('csv', { headerRow: 1 }),
  ))
  assert.deepEqual(rows.map((row) => row.ordinal), [2, 3, 4])
  assert.deepEqual(rows[0]?.value, { name: 'Ondřej', note: 'first\r\nsecond "quoted"' })
  assert.deepEqual(rows[1]?.value, { name: '', note: '' })
  assert.deepEqual(rows[2]?.value, { name: 'Zoe', note: 'end' })
})

test('TSV has an explicit header policy; malformed or mismatched CSV is refused with a locator', async () => {
  const rows = await collect(parseTaskSetSource(chunks('a\tb\n1\t2'), source('tsv')))
  assert.deepEqual(rows[0]?.value, ['a', 'b'])
  for (const content of ['a,a\n1,2', 'a,b\n1,2,3', 'a,b\n"unclosed', 'a,b\n"ok"no,2']) {
    await assert.rejects(collect(parseTaskSetSource(chunks(content), source('csv', { headerRow: 1 }))), TaskSetSourceError)
  }
})

test('JSON streams array records, selects nested arrays explicitly, and preserves nested input', async () => {
  const records = [{ id: 1, details: { label: 'Žlutý', tags: ['a', 'b'] } }, { id: 2, details: null }]
  const plain = await collect(parseTaskSetSource(chunks(JSON.stringify(records)), source('json')))
  assert.deepEqual(plain.map((row) => row.value), records)
  const nested = await collect(parseTaskSetSource(chunks(JSON.stringify({ data: { items: records } })),
    source('json', { recordPath: '/data/items' })))
  assert.deepEqual(nested.map((row) => row.value), records)
  const one = await collect(parseTaskSetSource(chunks(JSON.stringify(records[0])), source('json')))
  assert.deepEqual(one.map((row) => row.value), [records[0]])
  assert.deepEqual(taskSetMapInput(records[0], source('json', { fields: { selected: '/details/tags' } })),
    { selected: ['a', 'b'] })
  await assert.rejects(collect(parseTaskSetSource(chunks('{"other":[]}'), source('json', { recordPath: '/missing' }))),
    /did not select/)
})

test('JSONL does not silently discard invalid records; explicit row bounds preserve original ordinals', async () => {
  const records = await collect(parseTaskSetSource(chunks('{"id":1}\n{"id":2}\n{"id":3}\n'),
    source('jsonl', { firstRow: 2, lastRow: 2 })))
  assert.deepEqual(records.map((record) => record.ordinal), [2])
  await assert.rejects(collect(parseTaskSetSource(chunks('{"id":1}\n\n{"id":3}'), source('jsonl'))),
    (error: unknown) => error instanceof TaskSetSourceError && error.locator === 'line:2')
  await assert.rejects(collect(parseTaskSetSource(chunks('[1,2,'), source('json'))))
})

test('80,000 source items stream in bounded pages and restart with identical identity after interruption', async () => {
  const total = 80_000
  const bytes = (): Readable => Readable.from((function* () {
    for (let i = 1; i <= total; i++) yield Buffer.from(`${JSON.stringify({ id: i, nested: { name: `item ${i}` } })}\n`)
  })())
  const openStream: FileService['openStream'] = async () => ({
    stream: bytes(), attachment: { sizeBytes: 10_000_000n } as never,
  })
  const fileService = { openStream }
  let authorizations = 0
  const deps = {
    organizationId: PAGE, fileService,
    authorize: async () => { authorizations++; return { attachmentId: VERSION, disclosure } },
  }
  const settings = source('jsonl', { keyField: 'id' })
  const first = iterateTaskSetSource(deps, { source: settings })
  let last: TaskSetImportedItem | null = null
  for await (const item of first) { last = item; if (item.ordinal === 523) break }
  assert.equal(last?.ordinal, 523)
  let resumed = 0
  let nextKey = ''
  for await (const item of iterateTaskSetSource(deps, { source: settings, afterOrdinal: 523 })) {
    assert.equal(item.ordinal, 524 + resumed)
    if (!resumed) nextKey = item.key
    resumed++
  }
  assert.equal(resumed, total - 523)
  assert.ok(authorizations > 390, 'fresh access checks occur while the import progresses')
  const replay = iterateTaskSetSource(deps, { source: settings, afterOrdinal: 523 })
  const firstAgain = await replay.next()
  assert.equal(firstAgain.value?.key, nextKey)
  assert.deepEqual(firstAgain.value?.disclosure, disclosure)
  await replay.return(undefined)
})

test('revocation and attachment replacement stop an import before another page; provenance reaches the sink first', async () => {
  const content = Array.from({ length: 300 }, (_, id) => `${JSON.stringify({ id })}\n`).join('')
  const openStream: FileService['openStream'] = async () => ({
    stream: Readable.from([content]), attachment: { sizeBytes: 10000n } as never,
  })
  const fileService = { openStream }
  const admitted: unknown[] = []
  let checks = 0
  let count = 0
  const values = iterateTaskSetSource({
    organizationId: PAGE, fileService,
    authorize: async () => {
      checks++
      if (checks === 3) throw new TaskSetSourceError('authorization_lost', 'revoked')
      return { attachmentId: VERSION, disclosure }
    },
    consumedSources: {
      add: (value) => admitted.push(value), addPrivateConversationSource: (value) => admitted.push(value),
    },
  }, { source: source('jsonl') })
  await assert.rejects(async () => {
    for await (const item of values) { assert.ok(admitted.length > 0); count = item.ordinal }
  }, /revoked/)
  assert.equal(count, 200)
  checks = 0
  await assert.rejects(collect(iterateTaskSetSource({
    organizationId: PAGE, fileService,
    authorize: async () => ({ attachmentId: ++checks === 1 ? VERSION : PAGE, disclosure }),
  }, { source: source('jsonl') })), /same source bytes/)
})
