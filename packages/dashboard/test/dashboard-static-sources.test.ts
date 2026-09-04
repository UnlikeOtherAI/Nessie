import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import {
  buildWidgetProjection,
  DashboardServiceError,
  importStaticDashboardSource,
  parseStaticDataset,
} from '../src/index.js'

test('imports quoted CSV into a bounded self-contained dataset', async () => {
  const dataset = await parseStaticDataset({
    format: 'csv',
    content: 'Region,Revenue\n"North, East",42\nSouth,19\n',
  })

  assert.deepEqual(dataset.columns.map((column) => column.key), ['Region', 'Revenue'])
  assert.deepEqual(dataset.rows[0], { Region: 'North, East', Revenue: 42 })
})

test('refuses CSV ambiguity instead of shifting columns', async () => {
  await assert.rejects(
    () => parseStaticDataset({ format: 'csv', content: 'Region,Region\nNorth,South\n' }),
    (error: unknown) => error instanceof DashboardServiceError && error.code === 'CSV_DUPLICATE_HEADER',
  )
})

test('refuses nested JSON cells rather than coercing an invented value', async () => {
  await assert.rejects(
    () => parseStaticDataset({ format: 'json', content: '[{"month":"Q2","value":{"amount":2}}]' }),
    (error: unknown) => error instanceof DashboardServiceError && error.code === 'SOURCE_CELL_UNSUPPORTED',
  )
})

test('reads visible XLSX values without evaluating formulas', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Metrics')
  sheet.addRow(['Region', 'Revenue'])
  sheet.addRow(['North', 42])
  const bytes = await workbook.xlsx.writeBuffer()

  const dataset = await parseStaticDataset({
    format: 'xlsx',
    content: Buffer.from(bytes).toString('base64'),
  })

  assert.deepEqual(dataset.rows, [{ Region: 'North', Revenue: 42 }])
})

test('refuses XLSX formulas and retains document text as bounded evidence rows', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Metrics')
  sheet.addRow(['Revenue'])
  sheet.getCell('A2').value = { formula: '1+1', result: 2 }
  const bytes = await workbook.xlsx.writeBuffer()

  await assert.rejects(
    () => parseStaticDataset({ format: 'xlsx', content: Buffer.from(bytes).toString('base64') }),
    (error: unknown) => error instanceof DashboardServiceError && error.code === 'XLSX_FORMULAS_UNSUPPORTED',
  )
  const document = await parseStaticDataset({
    format: 'document',
    content: 'Revenue increased.\nRegional expansion begins.',
  })
  assert.deepEqual(document.rows[1], { sourceIndex: 2, documentText: 'Regional expansion begins.' })
})

test('refuses an XLSX archive whose central directory claims an unsafe expansion', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Metrics')
  sheet.addRow(['Revenue'])
  sheet.addRow([42])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const centralDirectory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.notEqual(centralDirectory, -1)
  // The central-directory uncompressed-size field is independent from the
  // tiny compressed input. A parser must reject it before ExcelJS expands it.
  bytes.writeUInt32LE(3 * 1024 * 1024, centralDirectory + 24)

  await assert.rejects(
    () => parseStaticDataset({ format: 'xlsx', content: bytes.toString('base64') }),
    (error: unknown) => error instanceof DashboardServiceError && error.code === 'XLSX_EXPANSION_TOO_LARGE',
  )
})

test('a Q2 presentation filter changes the data returned to every dashboard canvas', async () => {
  const sourceId = '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5a8'
  const projection = await buildWidgetProjection({
    dashboardPresentation: {
      attributions: [],
      filters: [{
        column: 'quarter',
        id: '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5a7',
        label: 'Q2 only',
        sourceId,
        values: ['Q2'],
      }],
      insights: [],
      style: 'executive',
    },
    dataset: { attachmentId: 'dataset-attachment', fetchedAt: new Date('2026-09-04T12:00:00.000Z') },
    loadDataset: async () => ({
      columns: [
        { key: 'quarter', label: 'Quarter', nullable: false, type: 'string' },
        { key: 'revenue', label: 'Revenue', nullable: false, type: 'number' },
      ],
      fetchedAt: '2026-09-04T12:00:00.000Z',
      rows: [{ quarter: 'Q1', revenue: 12 }, { quarter: 'Q2', revenue: 28 }],
      schemaVersion: 1,
    }),
    source: {
      intervalMinutes: null,
      kind: 'static',
      lastErrorCode: null,
      lastValidatedAt: new Date('2026-09-04T12:00:00.000Z'),
      latestDatasetId: 'dataset-id',
      outputColumns: [
        { key: 'quarter', label: 'Quarter', nullable: false, type: 'string' },
        { key: 'revenue', label: 'Revenue', nullable: false, type: 'number' },
      ],
      refreshMode: 'manual',
    },
    widget: {
      dashboardId: '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5a6',
      id: '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5b0',
      kind: 'bar',
      schemaVersion: 1,
      spec: {
        binding: { category: 'quarter', series: [{ key: 'revenue', label: 'Revenue' }] },
        kind: 'bar',
        presentation: { title: 'Revenue by quarter' },
        schemaVersion: 1,
        sourceId,
      },
    },
  })
  assert.deepEqual(projection.dataset?.rows, [{ quarter: 'Q2', revenue: 28 }])
})

test('a failed refresh with last-good data renders as recoverable error, not live', async () => {
  const sourceId = '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5a8'
  const projection = await buildWidgetProjection({
    dataset: { attachmentId: 'dataset-attachment', fetchedAt: new Date('2026-09-04T12:00:00.000Z') },
    loadDataset: async () => ({
      columns: [{ key: 'revenue', label: 'Revenue', nullable: false, type: 'number' }],
      fetchedAt: '2026-09-04T12:00:00.000Z',
      rows: [{ revenue: 28 }],
      schemaVersion: 1,
    }),
    source: {
      intervalMinutes: 15,
      kind: 'http',
      lastErrorCode: 'SOURCE_UNREACHABLE',
      lastValidatedAt: new Date('2026-09-04T12:00:00.000Z'),
      latestDatasetId: 'dataset-id',
      outputColumns: [{ key: 'revenue', label: 'Revenue', nullable: false, type: 'number' }],
      refreshMode: 'interval',
    },
    widget: {
      dashboardId: '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5a6',
      id: '1f2a3b4c-5d6e-4f70-8a90-b1c2d3e4f5b0',
      kind: 'stat',
      schemaVersion: 1,
      spec: {
        binding: { value: 'revenue' },
        kind: 'stat',
        presentation: { title: 'Revenue' },
        schemaVersion: 1,
        sourceId,
      },
    },
  })

  assert.equal(projection.state, 'error')
  assert.equal(projection.errorCode, 'SOURCE_UNREACHABLE')
  assert.deepEqual(projection.dataset?.rows, [{ revenue: 28 }])
})

test('an authorized document attachment keeps its actual original bytes and source claim', async () => {
  const organizationId = '00000000-0000-4000-8000-000000000001'
  const userId = '00000000-0000-4000-8000-000000000002'
  const attachmentId = '00000000-0000-4000-8000-000000000003'
  const sourceId = '00000000-0000-4000-8000-000000000004'
  const originalBytes = Buffer.from('%PDF-1.7 raw investor update', 'utf8')
  const storedBodies: Buffer[] = []
  let persistedMaterial: Record<string, unknown> | null = null
  const prisma = {
    attachment: {
      findFirst: async () => ({
        filename: 'investor-update.pdf',
        id: attachmentId,
        knowledgePageId: null,
        messageId: '00000000-0000-4000-8000-000000000005',
        mime: 'application/pdf',
        uploaderId: null,
      }),
    },
    dashboardDataSource: {
      create: async () => ({ id: sourceId, name: 'Investor update' }),
      delete: async () => undefined,
      update: async () => undefined,
    },
    dashboardDataset: { create: async () => ({ id: 'dataset-id' }) },
    dashboardSourceMaterial: {
      create: async (input: { data: Record<string, unknown> }) => {
        persistedMaterial = input.data
        return input.data
      },
    },
    knowledgePageVersion: { findFirst: async () => null },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  }
  const context = {
    actor: { organizationId, role: 'member' as const, userId },
    membership: {
      canReadKnowledgePageVersion: async () => false,
      canReadMessage: async () => true,
      isChannelMember: async () => false,
      isProjectMember: async () => false,
      isTeamMember: async () => false,
      subjectsForActor: async () => [],
    },
    prisma,
  } as never
  const files = {
    delete: async () => true,
    openStream: async () => ({ attachment: { id: attachmentId }, stream: Readable.from(originalBytes) }),
    store: async (input: { body: Readable }) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk))
      storedBodies.push(Buffer.concat(chunks))
      return { attachment: { id: `retained-${storedBodies.length}` }, bytesWritten: storedBodies.at(-1)!.byteLength }
    },
  } as never

  await importStaticDashboardSource(context, {
    content: 'Revenue grew in Q2.',
    format: 'document',
    name: 'Investor update',
    originalAttachmentId: attachmentId,
    provenance: { extraction: 'conversation attachment' },
    sourceReference: 'Investor update attachment',
  }, files)

  assert.deepEqual(storedBodies[0], originalBytes, 'the retained source is the uploaded document, not its extraction')
  assert.equal(persistedMaterial?.sourceReference, 'Investor update attachment')
  assert.equal(persistedMaterial?.originalAttachmentId, 'retained-1')
  assert.deepEqual(persistedMaterial?.provenance, {
    extraction: 'conversation attachment',
    originalAttachmentSource: `attachment:${attachmentId}`,
  })
})
