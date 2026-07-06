import assert from 'node:assert/strict'
import test from 'node:test'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runKbDraftWriteTool, runKbFileTool, runKbPublishRequestTool } from './knowledge-write.js'

const now = new Date('2026-01-01T00:00:00Z')

type PageFixtureOverrides = Partial<{
  id: string
  spaceId: string
  title: string
  status: 'draft' | 'published' | 'archived'
  authorType: 'user' | 'agent'
  projectId: string
  teamId: string | null
}>

const buildPageRow = (overrides: PageFixtureOverrides = {}) => ({
  id: overrides.id ?? 'page-1',
  spaceId: overrides.spaceId ?? 'space-1',
  title: overrides.title ?? 'Runbook',
  summary: null,
  metadata: null,
  kind: 'document',
  parentPageId: null,
  position: 0,
  status: overrides.status ?? 'published',
  labels: [],
  versions: [
    {
      id: 'version-1',
      pageId: overrides.id ?? 'page-1',
      versionNumber: 1,
      body: '<p>Hello world</p>',
      bodyRef: null,
      attachmentId: null,
      authorType: overrides.authorType ?? 'user',
      authorId: overrides.authorType === 'agent' ? 'agent-1' : 'user-1',
      changeComment: null,
      createdAt: now,
    },
  ],
  publishedVersion: null,
  publishedVersionId: null,
  organizationId: 'org-1',
  projectId: overrides.projectId ?? 'project-1',
  teamId: overrides.teamId ?? null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'organization',
  sensitivityTier: 'normal',
  privateToAgentId: null,
  createdBy: 'user-1',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
})

type SpaceFixtureOverrides = Partial<{
  id: string
  sensitivityTier: 'normal' | 'sensitive' | 'restricted'
}>

const buildSpaceRow = (overrides: SpaceFixtureOverrides = {}) => ({
  id: overrides.id ?? 'space-1',
  name: 'Engineering',
  description: null,
  metadata: null,
  writeRestricted: false,
  members: [],
  organizationId: 'org-1',
  projectId: 'project-1',
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'organization',
  sensitivityTier: overrides.sensitivityTier ?? 'normal',
  privateToAgentId: null,
  createdBy: 'user-1',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
})

type ApprovalRow = { id: string; context: Record<string, unknown> | null }

type FakePrismaOptions = {
  page?: ReturnType<typeof buildPageRow> | null
  space?: ReturnType<typeof buildSpaceRow> | null
  pendingApprovals?: ApprovalRow[]
}

const buildFakePrisma = (options: FakePrismaOptions = {}) => {
  const approvalCreateCalls: unknown[] = []
  const prisma = {
    knowledgePage: {
      findFirst: async () => options.page ?? null,
      findMany: async () => (options.page ? [options.page] : []),
      update: async () => options.page,
      updateMany: async () => ({ count: 1 }),
    },
    knowledgePageVersion: {
      findFirst: async () => options.page?.versions[0] ?? null,
      create: async () => options.page?.versions[0],
    },
    knowledgeSpace: {
      findFirst: async () => options.space ?? null,
    },
    agentBinding: {
      // The agent is org-bound in every fixture below, so org-visibility
      // spaces are always in reach — the tests isolate the write-gate under
      // test, not read-reach.
      findMany: async () => [{ channelId: 'channel-1', channel: { teamId: 'team-1', projectId: 'project-1' } }],
    },
    knowledgeSpaceMember: {
      findMany: async () => [],
    },
    approvalRequest: {
      findMany: async () => options.pendingApprovals ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        approvalCreateCalls.push(data)
        return { id: 'approval-new' }
      },
    },
    knowledgePageLink: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    $queryRaw: async () => [],
    // Wikilink title-resolution (resolveLinksToPage) issues a raw UPDATE on
    // title changes; these fixtures carry no pending links.
    $executeRaw: async () => 0,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  }
  return { prisma: prisma as unknown as BuiltinToolRuntimeContext['prisma'], approvalCreateCalls }
}

const makeContext = (
  prisma: BuiltinToolRuntimeContext['prisma'],
  overrides: Partial<BuiltinToolRuntimeContext> = {},
): BuiltinToolRuntimeContext =>
  ({
    agentId: 'agent-1',
    agentKind: 'shared',
    actorContext: {
      actor: { actorId: 'agent-1', actorType: 'agent', roles: [] },
      actionContext: {},
      tenant: { organizationId: 'org-1' },
    },
    channel: { id: 'channel-1', organizationId: 'org-1', systemChannelType: null },
    prisma,
    realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
    run: { id: 'run-1', messageId: 'message-1', threadId: 'thread-1' },
    ...overrides,
  }) as unknown as BuiltinToolRuntimeContext

test('kb_file denies an agent filing a published, human-authored page', async () => {
  const page = buildPageRow({ status: 'published', authorType: 'user' })
  const space = buildSpaceRow()
  const { prisma } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  await assert.rejects(
    () => runKbFileTool(context, { pageId: 'page-1', title: 'Renamed' }),
    /file draft pages you authored/,
  )
})

test('kb_file allows an agent filing its own agent-authored draft', async () => {
  const page = buildPageRow({ status: 'draft', authorType: 'agent' })
  const space = buildSpaceRow()
  const { prisma } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  const result = await runKbFileTool(context, { pageId: 'page-1', title: 'Renamed draft' })

  assert.equal(result.toolName, 'kb_file')
  assert.match(result.outputPreview, /updated title/)
})

test('kb_draft_write denies an agent writing into a restricted space', async () => {
  const space = buildSpaceRow({ sensitivityTier: 'restricted' })
  const { prisma } = buildFakePrisma({ space })
  const context = makeContext(prisma)

  await assert.rejects(
    () => runKbDraftWriteTool(context, { spaceId: 'space-1', title: 'New page', body: '<p>hi</p>' }),
    /restricted knowledge space/,
  )
})

test('kb_draft_write rejects a body carrying a script tag', async () => {
  const { prisma } = buildFakePrisma()
  const context = makeContext(prisma)

  await assert.rejects(
    () =>
      runKbDraftWriteTool(context, {
        spaceId: 'space-1',
        title: 'New page',
        body: '<p>hi</p><script>alert(1)</script>',
      }),
    /disallowed active content/,
  )
})

test('kb_draft_write rejects a body carrying an inline event-handler attribute', async () => {
  const { prisma } = buildFakePrisma()
  const context = makeContext(prisma)

  await assert.rejects(
    () =>
      runKbDraftWriteTool(context, {
        spaceId: 'space-1',
        title: 'New page',
        body: '<img src="x" onerror="alert(1)">',
      }),
    /disallowed active content/,
  )
})

test('kb_publish_request returns the existing pending approval instead of creating a duplicate', async () => {
  const page = buildPageRow({ status: 'draft', authorType: 'agent' })
  const space = buildSpaceRow()
  const { prisma, approvalCreateCalls } = buildFakePrisma({
    page,
    space,
    pendingApprovals: [{ id: 'approval-existing', context: { pageId: 'page-1', versionId: 'version-1' } }],
  })
  const context = makeContext(prisma)

  const result = await runKbPublishRequestTool(context, { pageId: 'page-1' })

  assert.match(result.outputPreview, /approval-existing/)
  assert.equal(approvalCreateCalls.length, 0)
})

test('kb_publish_request creates a new approval when none is pending', async () => {
  const page = buildPageRow({ status: 'draft', authorType: 'agent' })
  const space = buildSpaceRow()
  const { prisma, approvalCreateCalls } = buildFakePrisma({ page, space, pendingApprovals: [] })
  const context = makeContext(prisma)

  const result = await runKbPublishRequestTool(context, { pageId: 'page-1' })

  assert.match(result.outputPreview, /approval-new/)
  assert.equal(approvalCreateCalls.length, 1)
})
