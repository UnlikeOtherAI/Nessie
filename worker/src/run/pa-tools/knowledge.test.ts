import assert from 'node:assert/strict'
import test from 'node:test'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import {
  clampKbSearchLimit,
  runKbListTool,
  runKbPageReadTool,
  runKbSearchTool,
} from './knowledge.js'

const now = new Date('2026-01-01T00:00:00Z')

type PageFixtureOverrides = Partial<{
  id: string
  spaceId: string
  title: string
  sensitivityTier: 'normal' | 'sensitive' | 'restricted'
  privateToAgentId: string | null
  body: string
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
  status: 'published',
  labels: [],
  versions: [
    {
      id: 'version-1',
      pageId: overrides.id ?? 'page-1',
      versionNumber: 1,
      body: overrides.body ?? '<p>Hello world</p>',
      bodyRef: null,
      attachmentId: null,
      authorType: 'user',
      authorId: 'user-1',
      changeComment: null,
      createdAt: now,
    },
  ],
  publishedVersion: null,
  publishedVersionId: null,
  organizationId: 'org-1',
  projectId: 'project-1',
  teamId: null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: 'organization',
  sensitivityTier: overrides.sensitivityTier ?? 'normal',
  privateToAgentId: overrides.privateToAgentId ?? null,
  createdBy: 'user-1',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
})

type SpaceFixtureOverrides = Partial<{
  id: string
  visibility: 'private' | 'channel' | 'team' | 'project' | 'organization'
  teamId: string | null
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
  teamId: overrides.teamId ?? null,
  channelId: null,
  threadId: null,
  userId: null,
  visibility: overrides.visibility ?? 'organization',
  sensitivityTier: overrides.sensitivityTier ?? 'normal',
  privateToAgentId: null,
  createdBy: 'user-1',
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
})

type FakePrismaOptions = {
  page?: ReturnType<typeof buildPageRow> | null
  space?: ReturnType<typeof buildSpaceRow> | null
  agentBindings?: Array<{ channelId: string; channel: { teamId: string; projectId: string } }>
  agentSpaceMemberships?: Array<{ spaceId: string }>
}

const buildFakePrisma = (options: FakePrismaOptions = {}) => {
  const prisma = {
    knowledgePage: {
      findFirst: async () => options.page ?? null,
      findMany: async () => (options.page ? [options.page] : []),
    },
    knowledgeSpace: {
      findFirst: async () => options.space ?? null,
      findMany: async () => (options.space ? [options.space] : []),
    },
    agentBinding: {
      findMany: async () => options.agentBindings ?? [],
    },
    knowledgeSpaceMember: {
      findMany: async () => options.agentSpaceMemberships ?? [],
    },
    $queryRaw: async () => [],
  }
  return prisma as unknown as BuiltinToolRuntimeContext['prisma']
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

test('clampKbSearchLimit clamps to the 1-8 range and falls back to 5', () => {
  assert.equal(clampKbSearchLimit(undefined), 5)
  assert.equal(clampKbSearchLimit('not-a-number'), 5)
  assert.equal(clampKbSearchLimit(0), 1)
  assert.equal(clampKbSearchLimit(-3), 1)
  assert.equal(clampKbSearchLimit(3), 3)
  assert.equal(clampKbSearchLimit(20), 8)
  assert.equal(clampKbSearchLimit(8), 8)
})

test('kb_search degrades to lexical-only search when no modelClient is present', async () => {
  const prisma = buildFakePrisma()
  const context = makeContext(prisma) // no modelClient set

  const result = await runKbSearchTool(context, { query: 'deployment runbook', limit: 20 })

  assert.equal(result.toolName, 'kb_search')
  assert.match(result.outputPreview, /No knowledge-base pages matched/)
})

test('kb_search degrades to lexical-only search when embed() throws', async () => {
  const prisma = buildFakePrisma()
  const failingModelClient = {
    embed: async () => {
      throw new Error('embedding provider unavailable')
    },
  }
  const context = makeContext(prisma, {
    modelClient: failingModelClient as unknown as BuiltinToolRuntimeContext['modelClient'],
  })

  const result = await runKbSearchTool(context, { query: 'deployment runbook' })

  assert.equal(result.toolName, 'kb_search')
  assert.match(result.outputPreview, /No knowledge-base pages matched/)
})

test('kb_page_read denies an agent viewer when the page itself is restricted', async () => {
  const page = buildPageRow({ sensitivityTier: 'restricted' })
  const space = buildSpaceRow({ visibility: 'organization' })
  // Space is org-visibility and the agent is org-bound, so the space itself is
  // readable — the denial must come from the page's own restricted tier.
  const prisma = buildFakePrisma({
    page,
    space,
    agentBindings: [{ channelId: 'channel-1', channel: { teamId: 'team-1', projectId: 'project-1' } }],
  })
  const context = makeContext(prisma)

  const result = await runKbPageReadTool(context, { pageId: 'page-1' })

  assert.equal(result.toolName, 'kb_page_read')
  assert.equal(result.outputPreview, 'You do not have access to this knowledge page.')
})

test('kb_page_read denies an agent viewer when the page is privately scoped to a different agent', async () => {
  const page = buildPageRow({ privateToAgentId: 'agent-other' })
  const space = buildSpaceRow({ visibility: 'organization' })
  const prisma = buildFakePrisma({
    page,
    space,
    agentBindings: [{ channelId: 'channel-1', channel: { teamId: 'team-1', projectId: 'project-1' } }],
  })
  const context = makeContext(prisma)

  const result = await runKbPageReadTool(context, { pageId: 'page-1' })

  assert.equal(result.outputPreview, 'You do not have access to this knowledge page.')
})

test('kb_page_read returns the page body when the agent is allowed to read it', async () => {
  const page = buildPageRow({ body: '<p>Restart the service, then check logs.</p>' })
  const space = buildSpaceRow({ visibility: 'organization' })
  const prisma = buildFakePrisma({
    page,
    space,
    agentBindings: [{ channelId: 'channel-1', channel: { teamId: 'team-1', projectId: 'project-1' } }],
  })
  const context = makeContext(prisma)

  const result = await runKbPageReadTool(context, { pageId: 'page-1' })

  assert.match(result.outputPreview, /Title: Runbook/)
  assert.match(result.outputPreview, /Restart the service, then check logs\./)
})

test('kb_list denies access to a space the agent cannot read', async () => {
  const space = buildSpaceRow({ visibility: 'team', teamId: 'team-x' })
  // Agent has no bindings at all, so it is not org-bound and not a member of
  // team-x — team-visibility space must be denied.
  const prisma = buildFakePrisma({ space })
  const context = makeContext(prisma)

  const result = await runKbListTool(context, { spaceId: 'space-1' })

  assert.equal(result.toolName, 'kb_list')
  assert.equal(result.outputPreview, 'You do not have access to this knowledge space.')
})
