import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizationId, parseUserId } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { assertProjectWriteDestination, projectFor } from './ticket-context.js'

const member = {
  actorContext: {
    actionContext: { requestId: 'ticket-context-test' },
    actor: { actorId: parseUserId('22222222-2222-4222-8222-222222222222'), actorType: 'user' as const, roles: ['member'] },
    tenant: { organizationId: parseOrganizationId('11111111-1111-4111-8111-111111111111') },
  },
  isOwner: false,
  isOrganizationAdmin: false,
  organizationId: parseOrganizationId('11111111-1111-4111-8111-111111111111'),
  role: 'member',
  userId: parseUserId('22222222-2222-4222-8222-222222222222'),
}

const contextWithBinding = (binding: number): BuiltinToolRuntimeContext => ({
  agentId: '33333333-3333-4333-8333-333333333333',
  agentKind: 'shared',
  actorContext: member.actorContext,
  channel: {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId: member.organizationId,
    projectId: '55555555-5555-4555-8555-555555555555',
  },
  prisma: {
    agentBinding: { count: async () => binding },
    project: { count: async () => 1 },
    projectMember: { count: async () => 1 },
  },
} as unknown as BuiltinToolRuntimeContext)

test('a shared ticket agent rechecks its binding before every project operation', async () => {
  await assert.rejects(
    projectFor(contextWithBinding(0), member, '55555555-5555-4555-8555-555555555555'),
    /no longer bound/,
  )
  await projectFor(contextWithBinding(1), member, '55555555-5555-4555-8555-555555555555')
})

const checklistContext = (visibleAgents: Set<string>) => {
  const consumedSources = createConsumedSourceSink()
  return {
    consumedSources,
    context: {
      ...contextWithBinding(1),
      consumedSources,
      prisma: {
        agent: { count: async ({ where }: { where: { id: string } }) => Number(visibleAgents.has(where.id)) },
        organization: { findUnique: async () => ({ externalOrgId: null }) },
        organizationMember: {
          findFirst: async () => ({ id: 'membership-1' }),
          findMany: async () => [{ role: 'member', userId: member.userId }],
        },
        projectMember: { findMany: async () => [{ userId: member.userId }] },
        productAccountLink: { findUnique: async () => null },
      },
    } as unknown as BuiltinToolRuntimeContext,
  }
}

test('project writes permit a source every project reader can see and reject a private one', async () => {
  const shared = checklistContext(new Set(['public-agent']))
  shared.consumedSources.add({ scopeId: 'public-agent', scopeType: 'agent' })
  await assertProjectWriteDestination(shared.context, {
    organizationId: member.organizationId,
    projectId: '55555555-5555-4555-8555-555555555555',
  })

  const privateSource = checklistContext(new Set())
  privateSource.consumedSources.add({ scopeId: 'private-agent', scopeType: 'agent' })
  await assert.rejects(
    assertProjectWriteDestination(privateSource.context, {
      organizationId: member.organizationId,
      projectId: '55555555-5555-4555-8555-555555555555',
    }),
    /restricted research into this shared project/,
  )
})

type FakeChannel = {
  deletedAt: Date | null
  id: string
  organizationId: string
  projectId: string
  systemChannelType: string | null
  type: 'dm' | 'standard'
  visibility: 'private' | 'protected' | 'public'
}

const PROJECT_ID = '55555555-5555-4555-8555-555555555555'
const channelRow = (id: string, overrides: Partial<FakeChannel> = {}): FakeChannel => ({
  deletedAt: null, id, organizationId: member.organizationId, projectId: PROJECT_ID,
  systemChannelType: null, type: 'standard', visibility: 'public', ...overrides,
})

/** The gate's channel lookup, answered the way Postgres would answer its `where`. */
const channelContext = (channels: FakeChannel[]) => {
  const { consumedSources, context } = checklistContext(new Set())
  const channel = {
    findMany: async ({ where }: { where: Omit<FakeChannel, 'id'> & { id: { in: string[] } } }) => channels
      .filter((row) => where.id.in.includes(row.id)
        && row.deletedAt === where.deletedAt
        && row.organizationId === where.organizationId
        && row.projectId === where.projectId
        && row.systemChannelType === where.systemChannelType
        && row.type === where.type
        && row.visibility === where.visibility)
      .map(({ id }) => ({ id })),
  }
  return {
    consumedSources,
    context: { ...context, prisma: { ...(context.prisma as object), channel } } as unknown as BuiltinToolRuntimeContext,
  }
}

test('a public channel of the destination project that local apps were launched in is implied by its board', async () => {
  const channels = [
    channelRow('public-room'),
    channelRow('protected-room', { visibility: 'protected' }),
    channelRow('direct-message', { type: 'dm', visibility: 'private' }),
    channelRow('assistant-home', { systemChannelType: 'personal_assistant' }),
    channelRow('other-project-room', { projectId: '66666666-6666-4666-8666-666666666666' }),
    channelRow('deleted-room', { deletedAt: new Date() }),
  ]
  const write = { organizationId: member.organizationId, projectId: PROJECT_ID }

  const allowed = channelContext(channels)
  allowed.consumedSources.addHostOutputScope({ scopeId: 'public-room', scopeType: 'channel' })
  await assertProjectWriteDestination(allowed.context, write)

  for (const refused of channels.slice(1).map(({ id }) => id)) {
    const attempt = channelContext(channels)
    attempt.consumedSources.addHostOutputScope({ scopeId: 'public-room', scopeType: 'channel' })
    attempt.consumedSources.addHostOutputScope({ scopeId: refused, scopeType: 'channel' })
    await assert.rejects(
      assertProjectWriteDestination(attempt.context, write),
      /restricted research into this shared project/,
      refused,
    )
  }
})

test('a public channel carrying private-conversation lineage is still refused', async () => {
  // Its authors decide export, whatever the room has become since they spoke.
  const lineage = channelContext([channelRow('public-room')])
  lineage.consumedSources.addHostOutputScope({ scopeId: 'public-room', scopeType: 'channel' })
  lineage.consumedSources.addPrivateConversationSource({
    sourceAuthorUserId: member.userId,
    sourceChannelId: 'public-room',
  })
  await assert.rejects(
    assertProjectWriteDestination(lineage.context, { organizationId: member.organizationId, projectId: PROJECT_ID }),
    /restricted research into this shared project/,
  )
})

test('the same public channel from any other source is not implied', async () => {
  // A memory recalled because the viewer is a member of that public channel
  // stamps its channel audience. That is not a launch of local apps, and the
  // board stays closed to it as it was before host output had a rule.
  const recalled = channelContext([channelRow('public-room')])
  recalled.consumedSources.add({ scopeId: 'public-room', scopeType: 'channel' })
  await assert.rejects(
    assertProjectWriteDestination(recalled.context, { organizationId: member.organizationId, projectId: PROJECT_ID }),
    /restricted research into this shared project/,
  )
})
