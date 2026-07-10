import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { searchNativePages } from '../src/native-search.js'
import type { SpaceViewer } from '../src/access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'

const viewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
  bypass: false,
  projectIds: new Set(),
  userId,
  ...overrides,
})

const stubPrisma = (capture: { sql?: string }) =>
  ({
    $queryRaw: async (query: { sql: string }) => {
      capture.sql = query.sql
      return []
    },
    knowledgePage: { findMany: async () => [] },
  }) as unknown as PrismaClient

test('searchNativePages adds the space read pre-filter when a non-bypass viewer is supplied', async () => {
  const capture: { sql?: string } = {}
  await searchNativePages(stubPrisma(capture), {
    organizationId,
    query: 'runbook',
    viewer: viewer(),
  })

  assert.match(capture.sql ?? '', /AND p\.space_id IN \(\s*SELECT s\.id\s*FROM knowledge_spaces s/)
})

test('searchNativePages skips the space pre-filter for a bypass viewer', async () => {
  const capture: { sql?: string } = {}
  await searchNativePages(stubPrisma(capture), {
    organizationId,
    query: 'runbook',
    viewer: { bypass: true, projectIds: new Set(), userId: null },
  })

  assert.doesNotMatch(capture.sql ?? '', /knowledge_space_members/)
})

test('searchNativePages skips the space pre-filter when no viewer is supplied', async () => {
  const capture: { sql?: string } = {}
  await searchNativePages(stubPrisma(capture), {
    organizationId,
    query: 'runbook',
  })

  assert.doesNotMatch(capture.sql ?? '', /knowledge_space_members/)
})

test('searchNativePages filters to a ticket when taskId is supplied', async () => {
  const capture: { sql?: string } = {}
  await searchNativePages(stubPrisma(capture), {
    organizationId,
    query: 'runbook',
    taskId: '00000000-0000-4000-8000-000000000099',
  })

  assert.match(capture.sql ?? '', /AND p\.task_id = /)
})

test('searchNativePages omits the taskId filter when not supplied', async () => {
  const capture: { sql?: string } = {}
  await searchNativePages(stubPrisma(capture), {
    organizationId,
    query: 'runbook',
  })

  assert.doesNotMatch(capture.sql ?? '', /p\.task_id/)
})
