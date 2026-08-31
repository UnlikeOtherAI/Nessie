import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  KnowledgePageRecord,
  KnowledgeProvider,
  KnowledgeSpaceRecord,
} from '@nessie/knowledge'
import type { FileService } from '@nessie/runtime'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { runKbDocumentComposeTool } from './knowledge-compose.js'

const agentSpace = (ownerAgentId: string | null): KnowledgeSpaceRecord => ({
  channelId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  createdBy: ownerAgentId ?? 'user-1',
  deletedAt: null,
  description: null,
  id: 'space-1',
  memberAgentIds: [],
  memberUserIds: [],
  metadata: null,
  name: ownerAgentId ? 'Writer — Documents' : 'My Docs',
  organizationId: 'org-1',
  ownerAgentId,
  privateToAgentId: null,
  projectId: 'project-1',
  sensitivityTier: 'normal',
  teamId: null,
  threadId: null,
  updatedAt: '2026-08-31T00:00:00.000Z',
  userId: ownerAgentId ? null : 'user-1',
  visibility: 'private',
  writeRestricted: false,
})

const createdPage = (): KnowledgePageRecord => ({
  channelId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  createdBy: 'agent-1',
  deletedAt: null,
  id: 'page-1',
  kind: 'file',
  labels: [],
  latestVersion: {
    attachmentId: 'attachment-1',
    authorId: 'agent-1',
    authorType: 'agent',
    body: null,
    bodyRef: null,
    changeComment: null,
    createdAt: '2026-08-31T00:00:00.000Z',
    id: 'version-1',
    pageId: 'page-1',
    versionNumber: 1,
  },
  metadata: null,
  organizationId: 'org-1',
  parentPageId: null,
  position: 0,
  privateToAgentId: null,
  projectId: 'project-1',
  publishedVersion: null,
  publishedVersionId: null,
  sensitivityTier: 'normal',
  spaceId: 'space-1',
  status: 'draft',
  summary: null,
  taskId: null,
  teamId: null,
  threadId: null,
  title: 'notes.md',
  userId: null,
  visibility: 'private',
  updatedAt: '2026-08-31T00:00:00.000Z',
})

const makeHarness = (space: KnowledgeSpaceRecord) => {
  const consumedSources = createConsumedSourceSink()
  const publishCalls: unknown[] = []
  const createCalls: unknown[] = []
  const provider = {
    createPage: async (input: unknown) => {
      createCalls.push(input)
      return createdPage()
    },
    getSpace: async () => space,
    publishPage: async (input: unknown) => {
      publishCalls.push(input)
      return createdPage()
    },
  } as unknown as KnowledgeProvider
  const files = {
    store: async () => ({ attachment: { id: 'attachment-1' }, bytesWritten: 5 }),
  } as unknown as FileService
  const context = {
    actorContext: {
      actor: space.ownerAgentId
        ? { actorId: 'agent-1', actorType: 'agent', roles: [] }
        : { actorId: 'user-1', actorType: 'user', roles: [] },
      actionContext: {},
      tenant: { organizationId: 'org-1' },
    },
    agentId: 'agent-1',
    agentKind: 'shared',
    channel: { id: 'channel-1', organizationId: 'org-1' as never },
    consumedSources,
    prisma: {
      agent: {
        findMany: async () => [],
        findFirst: async () => ({
          bindings: [],
          knowledgeSpaceMemberships: [],
          parentAgentId: null,
        }),
      },
      projectMember: { findMany: async () => [] },
    },
    run: { id: 'run-1', messageId: 'message-1', threadId: 'thread-1' },
    toolCallId: null,
  } as unknown as BuiltinToolRuntimeContext
  return { consumedSources, context, createCalls, files, provider, publishCalls }
}

const compose = (harness: ReturnType<typeof makeHarness>) =>
  runKbDocumentComposeTool(
    harness.context,
    { markdown: 'Hello', spaceId: 'space-1', title: 'Notes' },
    { files: harness.files, provider: harness.provider },
  )

test('compose auto-publishes an agent-owned document when nothing was consumed', async () => {
  const harness = makeHarness(agentSpace('agent-1'))

  const result = await compose(harness)

  assert.equal(harness.createCalls.length, 1)
  assert.equal(harness.publishCalls.length, 1)
  assert.match(result.outputPreview, /published in that private space/)
})

test('compose saves an agent-owned document as a review draft after a foreign read', async () => {
  const harness = makeHarness(agentSpace('agent-1'))
  harness.consumedSources.add({ scopeId: 'project-foreign', scopeType: 'project' })

  const result = await compose(harness)

  assert.equal(harness.createCalls.length, 1)
  assert.equal(harness.publishCalls.length, 0)
  assert.match(result.outputPreview, /saved as a draft needing review/)
  assert.match(result.outputPreview, /kb_publish_request/)
})

test('ordinary private spaces retain their existing auto-publish result', async () => {
  const harness = makeHarness(agentSpace(null))
  harness.consumedSources.add({ scopeId: 'project-foreign', scopeType: 'project' })

  const result = await compose(harness)

  assert.equal(harness.publishCalls.length, 1)
  assert.match(result.outputPreview, /It is published in that private space\.$/)
})
