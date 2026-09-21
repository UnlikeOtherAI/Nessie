import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import type { PrismaClient } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'
import type { TaskSetDisclosure } from '@nessie/schemas'
import { renderTaskSetArtifact, type TaskSetArtifactRow } from '../src/task-set-output-render.js'
import {
  finalizeTaskSetArtifact, type TaskSetArtifactDeps, type TaskSetArtifactReceipt,
} from '../src/task-set-artifacts.js'
import type { CreatePageInput } from '../src/types.js'

const UUID = '00000000-0000-4000-8000-000000000001'
const BASIS: TaskSetDisclosure = {
  classified: true, basisScopes: [{ scopeType: 'user', scopeId: UUID }], disclosureSources: [],
}
async function* rows(): AsyncGenerator<TaskSetArtifactRow> {
  yield { id: UUID, sequence: 1, input: { company: '=2+2', nested: { id: 9 } },
    result: '{"summary":"=4+4","found":true}', disclosure: BASIS }
}

test('spreadsheet output preserves source input and writes mapped results as literal values, with source disclosure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-task-output-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'results.xlsx')
  const written = await renderTaskSetArtifact(path, {
    kind: 'spreadsheet', spaceId: UUID, fields: { Summary: 'summary', Found: 'found' },
  }, rows(), async () => undefined)
  assert.deepEqual(written.disclosure, BASIS)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  const sheet = workbook.getWorksheet('Results')!
  assert.deepEqual(JSON.parse(String(sheet.getCell('C2').value)), { company: '=2+2', nested: { id: 9 } })
  assert.equal(sheet.getCell('E2').value, '=4+4')
  assert.equal(sheet.getCell('E2').type, ExcelJS.ValueType.String)
  assert.equal(sheet.getCell('F2').value, true)
})

test('text and JSONL outputs need no receiving agent and refuse unclassified result data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-task-text-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'results.jsonl')
  await renderTaskSetArtifact(path, { kind: 'documents', spaceId: UUID, format: 'jsonl' }, rows(),
    async () => undefined)
  const value = JSON.parse(await readFile(path, 'utf8')) as { input: unknown; result: string }
  assert.deepEqual(value.input, { company: '=2+2', nested: { id: 9 } })
  assert.equal(value.result, '{"summary":"=4+4","found":true}')
  async function* missingBasis(): AsyncGenerator<TaskSetArtifactRow> {
    yield { id: UUID, sequence: 1, input: null, result: 'secret', disclosure: undefined }
  }
  await assert.rejects(renderTaskSetArtifact(join(directory, 'denied.txt'),
    { kind: 'documents', spaceId: UUID, format: 'text' }, missingBasis(), async () => undefined))
})

test('crash after storing an artifact resumes from its receipt; a completed effect never creates a second page', async () => {
  let stored = 0
  let created = 0
  let failCreate = true
  let receipt: TaskSetArtifactReceipt | undefined
  let page: CreatePageInput | null = null
  const deps: TaskSetArtifactDeps = {
    prisma: { knowledgePage: { findFirst: async () => page ? {
      ...page, deletedAt: null, versions: [{ attachmentId: page.attachmentId }],
    } : null } } as unknown as PrismaClient,
    fileService: {
      store: async (input) => {
        for await (const _chunk of input.body) { /* drain exactly as FileService does */ }
        stored++
        return { attachment: { id: UUID } as never, bytesWritten: 50 }
      },
      openStream: async () => ({ stream: Readable.from(['stored']), attachment: { id: UUID } as never }),
      delete: async () => undefined,
    },
    provider: { createPage: async (input) => {
      if (failCreate) throw new Error('simulated crash after receipt')
      page = input; created++
      return { id: input.id } as never
    } },
    authorizeDestination: async () => ({ spaceId: UUID, projectId: UUID, teamId: null, parentPageId: null }),
    recordReceipt: async (value) => { receipt = value },
  }
  const input = {
    organizationId: UUID, operationKey: 'set:finalize:1', title: 'Research',
    output: { kind: 'documents', spaceId: UUID, format: 'text' } as const,
    actor: { id: UUID, type: 'user' } as const, attribution: {} as LedgerAttribution, rows: rows(),
  }
  await assert.rejects(finalizeTaskSetArtifact(deps, input), /simulated crash/)
  assert.equal(stored, 1)
  assert.ok(receipt)
  failCreate = false
  async function* shouldNotRender(): AsyncGenerator<TaskSetArtifactRow> { throw new Error('rerendered') }
  const completed = await finalizeTaskSetArtifact(deps, { ...input, receipt, rows: shouldNotRender() })
  const replay = await finalizeTaskSetArtifact(deps, { ...input, rows: shouldNotRender() })
  assert.deepEqual(replay, completed)
  assert.equal(stored, 1)
  assert.equal(created, 1)
  assert.deepEqual((page as unknown as CreatePageInput).basisScopes, BASIS.basisScopes)
  ;(page as unknown as CreatePageInput).parentPageId = 'different-folder'
  await assert.rejects(finalizeTaskSetArtifact(deps, { ...input, receipt }), /moved, edited or deleted/)
})
