import assert from 'node:assert/strict'
import test from 'node:test'

import { readableSpaceIdsSql } from '../src/native-search-access.js'
import type { SpaceViewer } from '../src/access.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const projectId = '00000000-0000-4000-8000-000000000003'

const viewer = (overrides: Partial<SpaceViewer> = {}): SpaceViewer => ({
  bypass: false,
  projectIds: new Set(),
  userId,
  ...overrides,
})

test('readableSpaceIdsSql throws for a null-userId (bypass-only) viewer', () => {
  assert.throws(
    () => readableSpaceIdsSql(organizationId, viewer({ userId: null })),
    /requires a non-bypass viewer/,
  )
})

test('readableSpaceIdsSql includes the creator, org-visibility, and membership arms', () => {
  const fragment = readableSpaceIdsSql(organizationId, viewer())

  assert.match(fragment.sql, /s\.created_by = \?/)
  assert.match(fragment.sql, /s\.visibility = 'organization'::"ThoughtVisibility"/)
  assert.match(fragment.sql, /EXISTS \(\s*SELECT 1 FROM knowledge_space_members m/)
  assert.match(fragment.sql, /m\.user_id = \?::uuid/)
  assert.deepEqual(fragment.values, [organizationId, userId, userId])
})

test('readableSpaceIdsSql omits the project-visibility arm when projectIds is empty', () => {
  const fragment = readableSpaceIdsSql(organizationId, viewer())
  assert.doesNotMatch(fragment.sql, /project_id IN/)
})

test('readableSpaceIdsSql adds the project-visibility arm when projectIds is non-empty', () => {
  const fragment = readableSpaceIdsSql(
    organizationId,
    viewer({ projectIds: new Set([projectId]) }),
  )

  assert.match(
    fragment.sql,
    /visibility = 'project'::"ThoughtVisibility"\s*\n\s*AND s\.project_id IN \(\?::uuid\)/,
  )
  assert.deepEqual(fragment.values, [organizationId, userId, projectId, userId])
})
