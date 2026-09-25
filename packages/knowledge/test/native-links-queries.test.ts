import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { listBacklinks } from '../src/native-links-queries.js'
import type { SpaceViewer } from '../src/access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const pageId = '00000000-0000-4000-8000-000000000003'

const viewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
  bypass: false,
  projectIds: new Set(),
  userId,
  visibleAgentIds: new Set(),
  ...overrides,
})

type CapturedQuery = { sql: string }

const stubPrisma = (capture: { sql?: string }) =>
  ({
    $queryRaw: async (query: CapturedQuery) => {
      capture.sql = query.sql
      return []
    },
  }) as unknown as PrismaClient

// ---------------------------------------------------------------------------
// listBacklinks
// ---------------------------------------------------------------------------

test('listBacklinks adds the readable-space filter for a non-bypass (user) viewer', async () => {
  const capture: { sql?: string } = {}
  await listBacklinks(stubPrisma(capture), { organizationId, pageId, viewer: viewer() })

  assert.match(capture.sql ?? '', /AND p\.space_id IN \(\s*SELECT s\.id\s*FROM knowledge_spaces s/)
})

test('listBacklinks skips the space pre-filter for a bypass viewer', async () => {
  const capture: { sql?: string } = {}
  await listBacklinks(stubPrisma(capture), {
    organizationId,
    pageId,
    viewer: {
      bypass: true,
      userId: null,
      projectIds: new Set(),
      visibleAgentIds: new Set(),
    },
  })

  assert.doesNotMatch(capture.sql ?? '', /knowledge_space_members/)
})

test('listBacklinks skips the space pre-filter when no viewer is supplied', async () => {
  const capture: { sql?: string } = {}
  await listBacklinks(stubPrisma(capture), { organizationId, pageId })

  assert.doesNotMatch(capture.sql ?? '', /knowledge_space_members/)
})

test('listBacklinks joins knowledge_page_links to the source page and excludes archived/deleted pages', async () => {
  const capture: { sql?: string } = {}
  await listBacklinks(stubPrisma(capture), { organizationId, pageId })

  assert.match(capture.sql ?? '', /FROM knowledge_page_links l/)
  assert.match(capture.sql ?? '', /JOIN knowledge_pages p ON p\.id = l\.source_page_id/)
  assert.match(capture.sql ?? '', /p\.deleted_at IS NULL/)
  assert.match(capture.sql ?? '', /p\.status <> 'archived'/)
})
