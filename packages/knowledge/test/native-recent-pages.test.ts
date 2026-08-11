import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { clampRecentLimit, listNativeRecentPages } from '../src/native-recent-pages.js'
import type { SpaceViewer } from '../src/access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const spaceId = '00000000-0000-4000-8000-000000000004'
const pageId = '00000000-0000-4000-8000-000000000005'

const viewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
  bypass: false,
  projectIds: new Set(),
  userId,
  ...overrides,
})

type Capture = { sql?: string; values?: unknown[] }

const stubPrisma = (capture: Capture, rows: unknown[] = []) =>
  ({
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      capture.sql = query.sql
      capture.values = query.values
      return rows
    },
  }) as unknown as PrismaClient

test('listNativeRecentPages applies the space read pre-filter for a non-bypass viewer', async () => {
  const capture: Capture = {}
  await listNativeRecentPages(stubPrisma(capture), {
    organizationId,
    projectId,
    viewer: viewer(),
  })

  assert.match(capture.sql ?? '', /AND p\.space_id IN \(\s*SELECT s\.id\s*FROM knowledge_spaces s/)
  // The pre-filter is the shared canReadSpace mirror, not a rule rewritten
  // here: with no project memberships the caller only reaches their own spaces,
  // org-visible spaces, and spaces they are an explicit member of. A private
  // space someone else created in this project matches no arm.
  assert.match(capture.sql ?? '', /s\.created_by = /)
  assert.match(capture.sql ?? '', /s\.visibility = 'organization'/)
  assert.match(capture.sql ?? '', /knowledge_space_members/)
  assert.doesNotMatch(capture.sql ?? '', /s\.visibility = 'project'/)
})

test('listNativeRecentPages widens to project-visible spaces only for a member of that project', async () => {
  const capture: Capture = {}
  await listNativeRecentPages(stubPrisma(capture), {
    organizationId,
    projectId,
    viewer: viewer({ projectIds: new Set([projectId]) }),
  })

  assert.match(capture.sql ?? '', /s\.visibility = 'project'/)
})

test('listNativeRecentPages skips the space pre-filter for a bypass viewer', async () => {
  const capture: Capture = {}
  await listNativeRecentPages(stubPrisma(capture), {
    organizationId,
    projectId,
    viewer: { bypass: true, projectIds: new Set(), userId: null },
  })

  assert.doesNotMatch(capture.sql ?? '', /knowledge_space_members/)
})

test('listNativeRecentPages scopes to the project and excludes deleted and archived rows', async () => {
  const capture: Capture = {}
  await listNativeRecentPages(stubPrisma(capture), {
    organizationId,
    projectId,
    viewer: viewer(),
  })

  const sql = capture.sql ?? ''
  assert.match(sql, /AND p\.project_id = /)
  assert.match(sql, /AND p\.deleted_at IS NULL/)
  assert.match(sql, /AND p\.status <> 'archived'::"KnowledgePageStatus"/)
  assert.match(sql, /AND s\.deleted_at IS NULL/)
  assert.match(sql, /ORDER BY p\.updated_at DESC, p\.id DESC/)
  assert.ok(capture.values?.includes(projectId))
})

test('listNativeRecentPages defaults to 5 rows and caps the ask at 20', async () => {
  const defaulted: Capture = {}
  await listNativeRecentPages(stubPrisma(defaulted), { organizationId, projectId })
  assert.ok(defaulted.values?.includes(5))

  const capped: Capture = {}
  await listNativeRecentPages(stubPrisma(capped), { organizationId, projectId, limit: 500 })
  assert.ok(capped.values?.includes(20))
  assert.equal(capped.values?.includes(500), false)

  assert.equal(clampRecentLimit(undefined), 5)
  assert.equal(clampRecentLimit(0), 1)
  assert.equal(clampRecentLimit(7), 7)
  assert.equal(clampRecentLimit(21), 20)
})

test('listNativeRecentPages returns only the row fields the list renders', async () => {
  const capture: Capture = {}
  const rows = [
    {
      id: pageId,
      spaceId,
      spaceName: 'Engineering',
      title: 'Launch plan',
      kind: 'document',
      status: 'draft',
      updatedAt: new Date('2026-08-10T09:30:00.000Z'),
    },
  ]

  const data = await listNativeRecentPages(stubPrisma(capture, rows), {
    organizationId,
    projectId,
    viewer: viewer(),
  })

  assert.deepEqual(data, [
    {
      id: pageId,
      spaceId,
      spaceName: 'Engineering',
      title: 'Launch plan',
      kind: 'document',
      status: 'draft',
      updatedAt: '2026-08-10T09:30:00.000Z',
    },
  ])
  // No body, no version envelope, and explicitly no summary — the contract is
  // exactly what the Documents list draws.
  assert.doesNotMatch(capture.sql ?? '', /p\.summary/)
})
