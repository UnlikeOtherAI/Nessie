import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { KnowledgeSpaceRecord } from '@nessie/knowledge'
import { viewerSatisfiesBasis } from '@nessie/runtime'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { recordKnowledgeSpaceRead } from './knowledge-basis.js'

const space = (overrides: Partial<KnowledgeSpaceRecord> = {}): KnowledgeSpaceRecord => ({
  channelId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  createdBy: 'agent-1',
  deletedAt: null,
  description: null,
  id: 'space-1',
  memberAgentIds: [],
  memberUserIds: [],
  metadata: null,
  name: 'Agent documents',
  organizationId: 'org-1',
  ownerAgentId: null,
  privateToAgentId: null,
  projectId: 'project-1',
  sensitivityTier: 'normal',
  teamId: null,
  threadId: null,
  updatedAt: '2026-08-31T00:00:00.000Z',
  userId: null,
  visibility: 'project',
  writeRestricted: false,
  ...overrides,
})

test('reading an agent-owned space records its agent audience', () => {
  const consumedSources = createConsumedSourceSink()

  recordKnowledgeSpaceRead(
    { consumedSources },
    [space({ ownerAgentId: 'agent-1', visibility: 'private' })],
  )

  assert.deepEqual(consumedSources.list(), [
    { scopeId: 'agent-1', scopeType: 'agent' },
  ])
})

test('a reply built from an agent-owned read reaches only viewers who can see the agent', () => {
  const consumedSources = createConsumedSourceSink()
  recordKnowledgeSpaceRead(
    { consumedSources },
    [space({ ownerAgentId: 'agent-1', visibility: 'private' })],
  )

  const basis = consumedSources.list()
  assert.equal(viewerSatisfiesBasis(basis, {
    kind: 'user',
    scopes: [{ scopeId: 'agent-1', scopeType: 'agent' }],
    userId: 'viewer-1',
  }), true)
  assert.equal(viewerSatisfiesBasis(basis, {
    kind: 'user',
    scopes: [],
    userId: 'viewer-2',
  }), false)
})

test('ordinary knowledge spaces retain the existing visibility mapping', () => {
  const consumedSources = createConsumedSourceSink()

  recordKnowledgeSpaceRead(
    { consumedSources },
    [space({ ownerAgentId: null, projectId: 'project-7', visibility: 'project' })],
  )

  assert.deepEqual(consumedSources.list(), [
    { scopeId: 'project-7', scopeType: 'project' },
  ])
})

test('an omitted ownerAgentId projection fails loudly instead of publishing unscoped', () => {
  const consumedSources = createConsumedSourceSink()
  const incomplete: Partial<KnowledgeSpaceRecord> = space({ visibility: 'private' })
  delete incomplete.ownerAgentId

  assert.throws(
    () => recordKnowledgeSpaceRead(
      { consumedSources },
      [incomplete as KnowledgeSpaceRecord],
    ),
    /projection omitted ownerAgentId/,
  )
  assert.deepEqual(consumedSources.list(), [])
})
