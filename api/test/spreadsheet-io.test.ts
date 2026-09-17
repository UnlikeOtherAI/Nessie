import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SPREADSHEET_IMPORT_LIMITS,
  createEmptyWorkbook,
  exportXlsxBytes,
  importXlsxBytes,
  inspectUpload,
  isXlsxParsingEnabled,
} from '@nessie/knowledge'
import { SPREADSHEET_COMPACT_TOPIC } from '../src/routes/knowledge-spreadsheets-context.js'
import {
  SPREADSHEET_COMPACT_TOPIC as WORKER_COMPACT_TOPIC,
} from '../../worker/src/control/spreadsheet-compact.js'
import {
  SPREADSHEET_IMPORT_TOPIC as WORKER_IMPORT_TOPIC,
} from '../../worker/src/control/spreadsheet-import.js'
import { SPREADSHEET_IMPORT_TOPIC } from '../src/routes/knowledge-spreadsheets-io.js'

import {
  createSpreadsheetVia,
  dbAvailable,
  seedSpreadsheetRoutes,
} from './spreadsheet-route-fixture.ts'

const dbTest = dbAvailable ? test : test.skip

const multipartBody = (filename: string, bytes: Buffer): { payload: Buffer; headers: Record<string, string> } => {
  const boundary = '----nessie-spreadsheet-test'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

/** A real xlsx, produced by the engine itself. */
const sampleXlsx = (): Buffer => {
  const workbook = createEmptyWorkbook('Sheet1')
  workbook.model.setUserInput(0, 1, 1, 'Region')
  workbook.model.setUserInput(0, 2, 1, 'North')
  workbook.model.setUserInput(0, 2, 2, '=1+1')
  workbook.model.evaluate()
  return exportXlsxBytes(workbook)
}

test('the api and the worker name the same queue topics', () => {
  // Two constants, declared next to their publisher and their consumer. A
  // drifting pair would make an import or a compaction a job nobody runs, and
  // nothing else in the system would notice.
  assert.equal(SPREADSHEET_COMPACT_TOPIC, WORKER_COMPACT_TOPIC)
  assert.equal(SPREADSHEET_IMPORT_TOPIC, WORKER_IMPORT_TOPIC)
})

test('this process may not parse a workbook: the parse belongs on the worker', () => {
  // The guard that keeps `fromXlsx` off an API replica. It is a capability
  // rather than a convention because the failure mode is an uncatchable Rust
  // panic that takes the process — and every stream it is holding — down.
  assert.equal(isXlsxParsingEnabled(), false)
  assert.throws(
    () => importXlsxBytes(sampleXlsx()),
    (error: unknown) => {
      const details = (error as { details?: { reason?: string } }).details
      assert.equal(details?.reason, 'XLSX_PARSING_NOT_ENABLED_IN_THIS_PROCESS')
      return true
    },
  )
})

test('an upload is sniffed, capped and described without the engine seeing it', () => {
  const xlsx = sampleXlsx()
  const inspected = inspectUpload('book.xlsx', xlsx)
  assert.equal(inspected.format, 'xlsx')
  // Our own export is a fixed point: nothing in it is lost on a round trip.
  assert.deepEqual(inspected.warnings, [])

  assert.equal(inspectUpload('rows.csv', Buffer.from('a,b\n1,2\n')).format, 'csv')

  // The legacy format, refused by name. The engine's error for a 1997 `.xls`
  // is byte-identical to its error for a corrupt zip, so without the sniff a
  // person is told their file is broken rather than what to do about it.
  const ole2 = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512),
  ])
  assert.throws(
    () => inspectUpload('old.xls', ole2),
    (error: unknown) => {
      assert.match((error as Error).message, /older \.xls format/)
      assert.equal((error as { statusCode?: number }).statusCode, 415)
      return true
    },
  )

  // And the cap is on the *file* as well as on what it expands to.
  assert.throws(
    () => inspectUpload('huge.xlsx', Buffer.concat([
      Buffer.from('PK'),
      Buffer.alloc(SPREADSHEET_IMPORT_LIMITS.maxImportBytes + 1),
    ])),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 413,
  )
})

dbTest('an import creates the page now and hands the parse to the worker', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-import')
  try {
    const { payload, headers } = multipartBody('quarterly.xlsx', sampleXlsx())
    const response = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${fixture.spaceId}/spreadsheets/import`,
      payload,
      headers,
    })

    assert.equal(
      response.statusCode,
      202,
      `accepted, not done: the parse is the worker's. ${response.body.slice(0, 300)}`,
    )
    const body = response.json() as {
      data: { page: { id: string; kind: string }; status: string; warnings: unknown[] }
    }
    assert.equal(body.data.status, 'importing')
    assert.equal(body.data.page.kind, 'spreadsheet')

    // Rule zero: the page exists and is openable the moment the upload is
    // accepted, rather than appearing when a queue gets round to it.
    const head = await fixture.prisma.spreadsheetHead.findUniqueOrThrow({
      where: { pageId: body.data.page.id },
    })
    assert.equal(Number(head.headSeq), 0)
    const bootstrap = await fixture.request('owner', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${body.data.page.id}/spreadsheet`,
    })
    assert.equal(bootstrap.statusCode, 200)

    // The upload is kept beside the page: the worker reads bytes rather than
    // carrying a payload, and "what did I actually send?" keeps an answer.
    const upload = await fixture.prisma.attachment.findFirstOrThrow({
      where: { knowledgePageId: body.data.page.id },
    })
    assert.equal(upload.filename, 'quarterly.xlsx')

    // Scoped to this page: the queue is shared, and a suite must never read a
    // sibling suite's row.
    const job = await fixture.prisma.queueJob.findFirstOrThrow({
      where: {
        topic: SPREADSHEET_IMPORT_TOPIC,
        idempotencyKey: { startsWith: `sheet-import:${body.data.page.id}` },
      },
    })
    assert.deepEqual((job.payload as { pageId: string }).pageId, body.data.page.id)
    assert.equal((job.payload as { attachmentId: string }).attachmentId, upload.id)
  } finally {
    await fixture.teardown()
  }
})

dbTest('an .xls upload is refused by name, not as a corrupt file', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-import-xls')
  try {
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(2_048),
    ])
    const { payload, headers } = multipartBody('legacy.xls', ole2)
    const response = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${fixture.spaceId}/spreadsheets/import`,
      payload,
      headers,
    })
    assert.equal(response.statusCode, 415)
    const error = (response.json() as { error: { code: string; message: string } }).error
    assert.equal(error.code, 'SPREADSHEET_UNSUPPORTED_FEATURE')
    assert.match(error.message, /save it as \.xlsx/)
    // Nothing was created for a file that was never going to work.
    assert.equal(
      await fixture.prisma.knowledgePage.count({
        where: { organizationId: fixture.organizationId, kind: 'spreadsheet' },
      }),
      0,
    )
  } finally {
    await fixture.teardown()
  }
})

dbTest('converting a file node keeps the original and stages a new spreadsheet', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-convert')
  try {
    // A file node with real stored bytes, as an upload would leave it.
    const filePage = await fixture.prisma.knowledgePage.create({
      data: {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        spaceId: fixture.spaceId,
        title: 'quarterly',
        kind: 'file',
        createdBy: fixture.ids.owner,
      },
    })
    const attachment = await fixture.prisma.attachment.create({
      data: {
        organizationId: fixture.organizationId,
        kind: 'file',
        mime: 'application/vnd.ms-excel',
        filename: 'quarterly.xlsx',
        sizeBytes: 0n,
        storageKey: 'memory/missing',
      },
    })
    await fixture.prisma.knowledgePageVersion.create({
      data: {
        pageId: filePage.id,
        versionNumber: 1,
        attachmentId: attachment.id,
        authorType: 'user',
        authorId: fixture.ids.owner,
      },
    })

    // The bytes are not in the fake store, so the conversion refuses rather
    // than inventing an empty workbook — which is the honest failure.
    const response = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${filePage.id}/convert-to-spreadsheet`,
      payload: {},
    })
    assert.equal(response.statusCode, 400)

    // Converting a *document* is refused outright: only an uploaded file can
    // be opened as a spreadsheet.
    const documentPage = await fixture.prisma.knowledgePage.create({
      data: {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        spaceId: fixture.spaceId,
        title: 'notes',
        kind: 'document',
        createdBy: fixture.ids.owner,
      },
    })
    const refused = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${documentPage.id}/convert-to-spreadsheet`,
      payload: {},
    })
    assert.equal(refused.statusCode, 400)
    assert.match(
      (refused.json() as { error: { message: string } }).error.message,
      /Only an uploaded file/,
    )
    // The original is untouched either way: converting adds, never replaces.
    assert.equal(
      (await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: filePage.id } })).kind,
      'file',
    )
  } finally {
    await fixture.teardown()
  }
})

dbTest('export serves the live workbook as xlsx and as csv', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-export')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner')
    await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/structure`,
      payload: {
        action: {
          op: 'writeRange',
          sheet: 0,
          anchor: { row: 1, column: 1 },
          rows: [['Region', 'Revenue'], ['North', 120]],
        },
      },
    })

    const csv = await fixture.request('owner', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=csv`,
    })
    assert.equal(csv.statusCode, 200)
    assert.match(csv.headers['content-type'] as string, /text\/csv/)
    assert.match(csv.headers['content-disposition'] as string, /attachment; filename\*=UTF-8''/)
    // CRLF and a UTF-8 BOM: without them Excel reads a downloaded CSV in the
    // local code page and mangles every non-ASCII name in it.
    assert.equal(csv.rawPayload[0], 0xef)
    assert.equal(csv.rawPayload[1], 0xbb)
    assert.equal(csv.rawPayload[2], 0xbf)
    assert.equal(csv.body.replace(/^\uFEFF/, '').trim(), 'Region,Revenue\r\nNorth,120')

    const xlsx = await fixture.request('owner', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=xlsx`,
    })
    assert.equal(xlsx.statusCode, 200)
    assert.match(
      xlsx.headers['content-type'] as string,
      /spreadsheetml\.sheet/,
    )
    const bytes = xlsx.rawPayload
    assert.equal(bytes[0], 0x50, 'a real zip, not an empty body')
    assert.equal(bytes[1], 0x4b)
  } finally {
    await fixture.teardown()
  }
})
