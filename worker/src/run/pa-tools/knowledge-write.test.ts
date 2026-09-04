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
  authorId: string
  projectId: string
  teamId: string | null
  taskId: string | null
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
  taskId: overrides.taskId ?? null,
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
      authorId: overrides.authorId ?? (overrides.authorType === 'agent' ? 'agent-1' : 'user-1'),
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
  visibility: 'private' | 'channel' | 'team' | 'project' | 'organization'
  ownerAgentId: string | null
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
  visibility: overrides.visibility ?? 'organization',
  sensitivityTier: overrides.sensitivityTier ?? 'normal',
  privateToAgentId: null,
  ownerAgentId: overrides.ownerAgentId ?? null,
  createdBy: 'user-1',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
})

type ApprovalRow = { id: string; context: Record<string, unknown> | null }

type AgentFixture = {
  id: string
  organizationId: string
  ownerMembershipActive: boolean
  ownerUserId: string | null
  parentAgentId: string | null
  systemManaged: boolean
}

type FakePrismaOptions = {
  page?: ReturnType<typeof buildPageRow> | null
  space?: ReturnType<typeof buildSpaceRow> | null
  agents?: AgentFixture[]
  pendingApprovals?: ApprovalRow[]
  task?: { id: string } | null
}

const buildFakePrisma = (options: FakePrismaOptions = {}) => {
  const agents = options.agents ?? [
    {
      id: 'agent-1',
      organizationId: 'org-1',
      ownerMembershipActive: true,
      ownerUserId: 'user-1',
      parentAgentId: null,
      systemManaged: false,
    },
  ]
  const approvalCreateCalls: unknown[] = []
  const createPageCalls: Array<Record<string, unknown>> = []
  const createVersionCalls: Array<Record<string, unknown>> = []
  const updatePageCalls: unknown[] = []
  const movePageCalls: unknown[] = []
  const prisma = {
    agent: {
      findFirst: async (args: {
        where: { id: string; organizationId: string }
      }) => {
        const agent = agents.find(
          (candidate) => candidate.id === args.where.id && candidate.organizationId === args.where.organizationId,
        )
        if (!agent) return null
        return {
          parentAgentId: agent.parentAgentId,
          bindings: [{
            channelId: 'channel-1',
            channel: { teamId: 'team-1', projectId: 'project-1' },
          }],
          knowledgeSpaceMemberships: [],
        }
      },
      findMany: async (args: {
        select: { id?: boolean }
        where: {
          organizationId?: string
          systemManaged?: boolean
          AND?: Array<{
            OR?: Array<{
              ownerMembership?: { deactivatedAt?: null }
              ownerUserId?: string
              parentAgentId?: null
            }>
          }>
          OR?: Array<{
            ownerMembership?: { deactivatedAt?: null }
            ownerUserId?: string
            parentAgentId?: null
          }>
        }
      }) => {
        const ownerFilters = [
          ...(args.where.OR ?? []),
          ...(args.where.AND?.flatMap((condition) => condition.OR ?? []) ?? []),
        ].filter(
          (candidate) => candidate.ownerUserId !== undefined,
        )
        return agents
          .filter(
            (agent) =>
              agent.organizationId === args.where.organizationId
              && (args.where.systemManaged === undefined || agent.systemManaged === args.where.systemManaged)
              && ownerFilters.some(
                (filter) =>
                  agent.ownerUserId === filter.ownerUserId
                  && (!filter.ownerMembership || agent.ownerMembershipActive)
                  && (filter.parentAgentId === undefined || agent.parentAgentId === filter.parentAgentId),
              ),
          )
          .map((agent) => ({ ...(args.select.id ? { id: agent.id } : {}) }))
      },
    },
    knowledgePage: {
      findFirst: async () => options.page ?? null,
      findMany: async () => (options.page ? [options.page] : []),
      update: async (args: unknown) => {
        updatePageCalls.push(args)
        return options.page
      },
      updateMany: async (args: unknown) => {
        movePageCalls.push(args)
        return { count: 1 }
      },
      count: async () => 0,
      create: async (args: { data: Record<string, unknown> }) => {
        createPageCalls.push(args.data)
        return { id: options.page?.id ?? 'page-new', title: args.data['title'] }
      },
    },
    knowledgePageVersion: {
      findFirst: async () => options.page?.versions[0] ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        createVersionCalls.push(args.data)
        return options.page?.versions[0] ?? {
          id: 'version-1',
          pageId: options.page?.id ?? 'page-new',
          versionNumber: 1,
          body: '<p>hi</p>',
          bodyRef: null,
          attachmentId: null,
          authorType: 'agent',
          authorId: 'agent-1',
          changeComment: null,
          createdAt: now,
        }
      },
    },
    knowledgeSpace: {
      findFirst: async () => options.space ?? null,
    },
    projectMember: {
      findMany: async () => [{ projectId: 'project-1' }],
    },
    task: {
      findFirst: async () => options.task === undefined ? { id: 'task-1' } : options.task,
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
  return {
    prisma: prisma as unknown as BuiltinToolRuntimeContext['prisma'],
    approvalCreateCalls,
    createPageCalls,
    createVersionCalls,
    movePageCalls,
    updatePageCalls,
  }
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
      actionContext: {
        requestId: 'request-1',
      },
      tenant: { organizationId: 'org-1', teamId: 'team-1' },
    },
    channel: { id: 'channel-1', organizationId: 'org-1', systemChannelType: null },
    prisma,
    realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
    run: {
      id: 'run-1',
      messageId: 'message-1',
      originatingUserId: 'user-1',
      threadId: 'thread-1',
    },
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

test('kb_file denies an agent filing another agent\'s draft', async () => {
  const page = buildPageRow({ authorId: 'agent-2', authorType: 'agent', status: 'draft' })
  const space = buildSpaceRow()
  const { prisma, movePageCalls, updatePageCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  await assert.rejects(
    () => runKbFileTool(context, { pageId: 'page-1', parentPageId: 'folder-1', title: 'Takeover' }),
    /file draft pages you authored/,
  )
  assert.equal(movePageCalls.length, 0)
  assert.equal(updatePageCalls.length, 0)
})

test('kb_file preserves its authorship limit when a PA is delegated to a user', async () => {
  const page = buildPageRow({ authorId: 'agent-2', authorType: 'agent', status: 'draft' })
  const space = buildSpaceRow()
  const { prisma, movePageCalls, updatePageCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma, {
    agentKind: 'personal_assistant',
    actorContext: {
      actor: { actorId: 'agent-1', actorType: 'agent', roles: [] },
      actionContext: { effectiveUserId: 'user-1', requestId: 'request-1' },
      tenant: { organizationId: 'org-1', teamId: 'team-1' },
    } as unknown as BuiltinToolRuntimeContext['actorContext'],
  })

  await assert.rejects(
    () => runKbFileTool(context, { pageId: 'page-1', parentPageId: 'folder-1', title: 'Takeover' }),
    /file draft pages you authored/,
  )
  assert.equal(movePageCalls.length, 0)
  assert.equal(updatePageCalls.length, 0)
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

test('kb_draft_write binds a newly created page to its ticket via taskId', async () => {
  const page = buildPageRow({ id: 'page-new', title: 'Design notes', taskId: 'task-1' })
  const space = buildSpaceRow()
  const { prisma, createPageCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  const result = await runKbDraftWriteTool(context, {
    spaceId: 'space-1',
    title: 'Design notes',
    body: '<p>hi</p>',
    taskId: 'task-1',
  })

  assert.equal(result.toolName, 'kb_draft_write')
  assert.equal(createPageCalls.length, 1)
  assert.equal(createPageCalls[0]?.['taskId'], 'task-1')
  assert.match(result.outputPreview, /Created draft page "Design notes"/)
})

test('kb_draft_write rejects binding a writable space to a ticket in another project', async () => {
  const page = buildPageRow({ id: 'page-new', title: 'Design notes' })
  const space = buildSpaceRow()
  const { prisma, createPageCalls } = buildFakePrisma({ page, space, task: null })
  const context = makeContext(prisma)

  await assert.rejects(
    () =>
      runKbDraftWriteTool(context, {
        spaceId: 'space-1',
        title: 'Design notes',
        body: '<p>hi</p>',
        taskId: 'foreign-task',
      }),
    /Ticket not found in this knowledge space project/,
  )
  assert.equal(createPageCalls.length, 0)
})

test('kb_draft_write defaults taskId to null on a new page when not supplied', async () => {
  const page = buildPageRow({ id: 'page-new', title: 'Design notes' })
  const space = buildSpaceRow()
  const { prisma, createPageCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  await runKbDraftWriteTool(context, { spaceId: 'space-1', title: 'Design notes', body: '<p>hi</p>' })

  assert.equal(createPageCalls.length, 1)
  assert.equal(createPageCalls[0]?.['taskId'], null)
})

test('a delegating personal assistant writes with user access but agent authorship', async () => {
  const page = buildPageRow({ id: 'page-new', title: 'Delegated notes', authorType: 'agent' })
  const space = buildSpaceRow({ visibility: 'private', ownerAgentId: 'agent-1' })
  const { prisma, createPageCalls, createVersionCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma, {
    agentKind: 'personal_assistant',
    actorContext: {
      actor: { actorId: 'agent-1', actorType: 'agent', roles: [] },
      actionContext: {
        effectiveUserId: 'user-1',
        requestId: 'request-1',
      },
      tenant: { organizationId: 'org-1', teamId: 'team-1' },
    } as unknown as BuiltinToolRuntimeContext['actorContext'],
  })

  await runKbDraftWriteTool(context, {
    spaceId: 'space-1',
    title: 'Delegated notes',
    body: '<p>Generated by the PA.</p>',
  })

  assert.equal(createPageCalls.length, 1)
  assert.equal(createPageCalls[0]?.['createdBy'], 'agent-1')
  assert.equal(createVersionCalls.length, 1)
  assert.equal(createVersionCalls[0]?.['authorType'], 'agent')
  assert.equal(createVersionCalls[0]?.['authorId'], 'agent-1')
})

test('kb_publish_request rejects a human-authored draft', async () => {
  const page = buildPageRow({ status: 'draft', authorType: 'user' })
  const space = buildSpaceRow()
  const { prisma, approvalCreateCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  await assert.rejects(
    () => runKbPublishRequestTool(context, { pageId: 'page-1' }),
    /Only agent-authored drafts/,
  )
  assert.equal(approvalCreateCalls.length, 0)
})

test('kb_publish_request denies a draft written by another agent', async () => {
  const page = buildPageRow({ authorId: 'agent-2', authorType: 'agent', status: 'draft' })
  const space = buildSpaceRow()
  const { prisma, approvalCreateCalls } = buildFakePrisma({ page, space })
  const context = makeContext(prisma)

  await assert.rejects(
    () => runKbPublishRequestTool(context, { pageId: 'page-1' }),
    /Only agent-authored drafts/,
  )
  assert.equal(approvalCreateCalls.length, 0)
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
