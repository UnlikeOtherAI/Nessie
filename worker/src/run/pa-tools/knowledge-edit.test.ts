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
import { runKbDocumentEditTool } from './knowledge-edit.js'

const space = (ownerAgentId: string | null): KnowledgeSpaceRecord => ({
  channelId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  createdBy: ownerAgentId ?? 'user-1',
  deletedAt: null,
  description: null,
  id: 'space-1',
  memberAgentIds: [],
  memberUserIds: [],
  metadata: null,
  name: 'Documents',
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

const page = (status: 'draft' | 'published'): KnowledgePageRecord => ({
  channelId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  createdBy: 'agent-1',
  deletedAt: null,
  id: 'page-1',
  kind: 'file',
  labels: [],
  latestVersion: null,
  metadata: null,
  organizationId: 'org-1',
  parentPageId: null,
  position: 0,
  privateToAgentId: null,
  projectId: 'project-1',
  publishedVersion: null,
  publishedVersionId: status === 'published' ? 'version-1' : null,
  sensitivityTier: 'normal',
  spaceId: 'space-1',
  status,
  summary: null,
  taskId: null,
  teamId: null,
  threadId: null,
  title: 'notes.md',
  updatedAt: '2026-08-31T00:00:00.000Z',
  userId: null,
  visibility: 'private',
})

const makeHarness = (
  targetSpace: KnowledgeSpaceRecord,
  targetPage: KnowledgePageRecord,
) => {
  const consumedSources = createConsumedSourceSink()
  const publishCalls: unknown[] = []
  const versionCalls: unknown[] = []
  const storeCalls: unknown[] = []
  const provider = {
    addFileVersion: async (input: unknown) => {
      versionCalls.push(input)
      return { versionNumber: 2 }
    },
    getPage: async () => targetPage,
    getSpace: async () => targetSpace,
    publishPage: async (input: unknown) => {
      publishCalls.push(input)
      return targetPage
    },
  } as unknown as KnowledgeProvider
  const files = {
    store: async (input: unknown) => {
      storeCalls.push(input)
      return { attachment: { id: 'attachment-2' }, bytesWritten: 5 }
    },
  } as unknown as FileService
  const context = {
    actorContext: {
      actor: { actorId: 'agent-1', actorType: 'agent', roles: [] },
      actionContext: {},
      tenant: { organizationId: 'org-1' },
    },
    agentId: 'agent-1',
    agentKind: 'shared',
    channel: { id: 'channel-1', organizationId: 'org-1' as never },
    consumedSources,
    prisma: {
      agent: {
        findFirst: async () => ({
          bindings: [],
          knowledgeSpaceMemberships: [],
          parentAgentId: null,
        }),
      },
    },
    run: { id: 'run-1', messageId: 'message-1', threadId: 'thread-1' },
    toolCallId: null,
  } as unknown as BuiltinToolRuntimeContext
  return { consumedSources, context, files, provider, publishCalls, storeCalls, versionCalls }
}

const edit = (harness: ReturnType<typeof makeHarness>) =>
  runKbDocumentEditTool(
    harness.context,
    { edits: [{ find: 'old', replace: 'new' }], pageId: 'page-1' },
    {
      files: harness.files,
      provider: harness.provider,
      readDocument: async () => ({
        attachmentId: 'attachment-1',
        content: 'old text',
        parentPageId: null,
        spaceId: 'space-1',
        title: 'notes.md',
      }),
    },
  )

test('editing a published agent document republishes only audience-covered content', async () => {
  const harness = makeHarness(space('agent-1'), page('published'))

  const result = await edit(harness)

  assert.equal(harness.publishCalls.length, 1)
  assert.deepEqual(harness.consumedSources.list(), [
    { scopeId: 'agent-1', scopeType: 'agent' },
  ])
  assert.match(result.outputPreview, /new version is published/)
})

test('editing refuses a wider-audience disclosure before storing an attachment or version', async () => {
  const harness = makeHarness(space('agent-1'), page('published'))
  harness.consumedSources.add({ scopeId: 'project-foreign', scopeType: 'project' })

  const result = await edit(harness)

  assert.equal(harness.storeCalls.length, 0)
  assert.equal(harness.versionCalls.length, 0)
  assert.equal(harness.publishCalls.length, 0)
  assert.match(result.outputPreview, /cannot save this version/)
  assert.match(result.outputPreview, /existing document is unchanged/)
  assert.doesNotMatch(result.outputPreview, /kb_publish_request/)
})

test('editing a published agent document republishes after an organization-visibility read', async () => {
  const harness = makeHarness(space('agent-1'), page('published'))
  harness.consumedSources.add({ scopeId: 'org-1', scopeType: 'organization' })

  const result = await edit(harness)

  assert.equal(harness.versionCalls.length, 1)
  assert.equal(harness.publishCalls.length, 1)
  assert.match(result.outputPreview, /new version is published/)
})

test('editing an existing draft never flips it to published', async () => {
  const harness = makeHarness(space('agent-1'), page('draft'))

  const result = await edit(harness)

  assert.equal(harness.publishCalls.length, 0)
  assert.match(result.outputPreview, /already a draft/)
})
