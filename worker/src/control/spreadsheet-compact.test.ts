import assert from 'node:assert/strict'
import test from 'node:test'

import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import {
  SPREADSHEET_COMPACT_TOPIC,
  SpreadsheetCompactJobPayloadSchema,
  spreadsheetCompactJobKey,
} from './spreadsheet-compact.js'
import {
  SPREADSHEET_IMPORT_TOPIC,
  SpreadsheetImportJobPayloadSchema,
} from './spreadsheet-import.js'

/**
 * The two spreadsheet jobs' contracts. The bodies are exercised against a real
 * database by `packages/knowledge/test/spreadsheet-versions.test.ts` (the
 * snapshot they take) and `api/test/spreadsheet-io.test.ts` (the hand-off that
 * enqueues them); what is left, and what a drifting change would break in
 * silence, is the shape of the payloads and the keys.
 */

test('a compaction payload names the page and its organisation', () => {
  const parsed = SpreadsheetCompactJobPayloadSchema.parse({
    organizationId: '00000000-0000-4000-8000-000000000001',
    pageId: '00000000-0000-4000-8000-000000000002',
    seq: 200,
  })
  assert.equal(parsed.seq, 200)
  // `seq` is advisory — it names the cadence step for the key and nothing else
  // — so a job enqueued without one is still a valid job.
  assert.equal(
    SpreadsheetCompactJobPayloadSchema.parse({
      organizationId: '00000000-0000-4000-8000-000000000001',
      pageId: '00000000-0000-4000-8000-000000000002',
    }).seq,
    undefined,
  )
  assert.throws(() => SpreadsheetCompactJobPayloadSchema.parse({ pageId: 'not-a-uuid' }))
})

test('two replicas crossing the cadence together enqueue one compaction, not two', () => {
  const pageId = '00000000-0000-4000-8000-000000000002'
  const cadence = SPREADSHEET_LIMITS.compactEveryBatches

  // The same cadence step: one key, so the queue's idempotency collapses them.
  assert.equal(
    spreadsheetCompactJobKey(pageId, cadence),
    spreadsheetCompactJobKey(pageId, cadence + 1),
  )
  // The next step is a different job: a busy page still gets compacted again.
  assert.notEqual(
    spreadsheetCompactJobKey(pageId, cadence),
    spreadsheetCompactJobKey(pageId, cadence * 2),
  )
})

test('an import payload carries everything the worker needs and nothing it should trust', () => {
  const payload = SpreadsheetImportJobPayloadSchema.parse({
    organizationId: '00000000-0000-4000-8000-000000000001',
    pageId: '00000000-0000-4000-8000-000000000002',
    attachmentId: '00000000-0000-4000-8000-000000000003',
    filename: 'quarterly.xlsx',
    actorId: '00000000-0000-4000-8000-000000000004',
    actorType: 'user',
  })
  // The bytes are read from the attachment, never carried on the queue: a
  // 16 MiB payload in a job row is a different kind of problem.
  assert.equal('bytes' in payload, false)
  assert.equal(payload.filename, 'quarterly.xlsx')
  assert.throws(() =>
    SpreadsheetImportJobPayloadSchema.parse({
      organizationId: '00000000-0000-4000-8000-000000000001',
      pageId: '00000000-0000-4000-8000-000000000002',
      attachmentId: '00000000-0000-4000-8000-000000000003',
      filename: 'quarterly.xlsx',
      actorId: '00000000-0000-4000-8000-000000000004',
      actorType: 'service',
    }),
  )
})

test('the topics are the names the api publishes under', () => {
  assert.equal(SPREADSHEET_COMPACT_TOPIC, 'spreadsheet.compact')
  assert.equal(SPREADSHEET_IMPORT_TOPIC, 'spreadsheet.import')
})
