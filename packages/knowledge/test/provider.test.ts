import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  createNativeKnowledgeProvider,
} from '../src/index.js'
import {
  KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING,
  KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING,
} from '../src/scoped-mappings.js'

const scopedColumns = {
  channelId: 'channel_id',
  organizationId: 'organization_id',
  privateToAgentId: 'private_to_agent_id',
  projectId: 'project_id',
  sensitivityTier: 'sensitivity_tier',
  teamId: 'team_id',
  threadId: 'thread_id',
  userId: 'user_id',
  visibility: 'visibility',
}

test('native provider declares governed first-party capabilities', () => {
  const provider = createNativeKnowledgeProvider({} as PrismaClient)

  assert.equal(provider.kind, 'first_party')
  assert.deepEqual(provider.capabilities, {
    canWrite: true,
    canIncrementalSync: false,
    supportsNativeSearch: true,
    supportsServerSideACL: true,
    supportsVersionHistory: true,
    supportsHierarchicalPages: true,
    supportsDeterministicSearch: true,
  })
})

test('knowledge models satisfy the shared scoped-content contract', () => {
  assert.deepEqual(KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING.columns, scopedColumns)
  assert.deepEqual(KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING.columns, scopedColumns)
  assert.equal(KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING.deletedAtColumn, 'deleted_at')
  assert.equal(KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING.deletedAtColumn, 'deleted_at')
})

test('native source refs are stable and version-addressable', () => {
  assert.equal(
    buildNativeSourceRef('page-1', 'version-2'),
    'kb://first-party/pages/page-1/versions/version-2',
  )
  assert.equal(buildNativeSourceRef('page-1', null), 'kb://first-party/pages/page-1')
  assert.equal(buildSpaceSourceRef('space-1'), 'kb://first-party/spaces/space-1')
})
