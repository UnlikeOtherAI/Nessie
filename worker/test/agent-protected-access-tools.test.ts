import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  runAgentToolAccessInspectTool,
  runAgentToolAccessSetTool,
} from '../src/run/pa-tools/agent-config.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the protected-access handler to refuse')
}

const contextFor = (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; agentId: string },
  published: Array<{ event: string; scopes: unknown }>,
): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { requestId: randomUUID() },
    actor: { actorId: input.userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: input.organizationId },
  },
  agentId: input.agentId,
  agentKind: 'shared',
  channel: { id: randomUUID(), organizationId: input.organizationId },
  prisma,
  realtimeTransport: {
    publishWs: async (scopes: unknown, event: { event: string }) => {
      published.push({ event: event.event, scopes })
    },
  },
  run: { id: randomUUID(), interactive: true, messageId: randomUUID(), threadId: randomUUID() },
  toolCallId: randomUUID(),
} as unknown as BuiltinToolRuntimeContext)

const catalogEntry = (prisma: PrismaClient, input: { organizationId: string; userId: string }) =>
  prisma.mcpCatalogEntry.create({
    data: {
      authMethod: 'none', authConfig: {}, createdBy: input.userId,
      defaultTransportConfig: {}, description: 'Protected test connector', label: 'Protected connector',
      name: `protected-${randomUUID()}`, organizationId: input.organizationId,
      ownerUserId: input.userId, protocol: 'http', status: 'published', visibility: 'private',
    },
  })

const protectedMcpTool = async (prisma: PrismaClient, input: {
  catalogEntryId: string; organizationId: string; installedBy: string; scopeId: string; scopeType: 'channel' | 'user'; label: string
}) => {
  const instance = await prisma.mcpServerInstance.create({
    data: {
      catalogEntryId: input.catalogEntryId, installedBy: input.installedBy, lifecycleState: 'active',
      organizationId: input.organizationId, requiresExplicitToolGrant: true, scopeId: input.scopeId, scopeType: input.scopeType,
    },
  })
  return prisma.toolRegistryEntry.create({
    data: {
      description: `${input.label} descriptor`, handlerKind: 'mcp', inputSchema: { type: 'object' }, label: input.label,
      mcpInstanceId: instance.id, metadata: { requiresExplicitGrant: true }, organizationId: input.organizationId,
      overview: `${input.label} descriptor`, scopeKey: instance.id, source: 'mcp_remote', status: 'active',
      toolId: `mcp:${instance.id}:run`, transport: 'mcp', transportConfig: { toolName: 'run' },
    },
  })
}

dbTest('protected access revalidates owner, tenant, connector visibility, executor authority, and descriptor freshness', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const foreignOrganizationId = randomUUID()
  const ownerUserId = randomUUID()
  const demotedUserId = randomUUID()
  const otherUserId = randomUUID()
  const agentId = randomUUID()
  const foreignAgentId = randomUUID()
  const personalAssistantChannelId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const privateChannelId = randomUUID()
  const published: Array<{ event: string; scopes: unknown }> = []
  try {
    await prisma.organization.createMany({ data: [
      { id: organizationId, name: 'Protected access owner org' },
      { id: foreignOrganizationId, name: 'Protected access foreign org' },
    ] })
    await prisma.user.createMany({ data: [ownerUserId, demotedUserId, otherUserId].map((id) => ({ id, displayName: 'Protected access user', email: `${id}@test.local` })) })
    await prisma.organizationMember.createMany({ data: [
      { organizationId, role: 'owner', userId: ownerUserId },
      { organizationId, role: 'owner', userId: demotedUserId },
      { organizationId, role: 'member', userId: otherUserId },
    ] })
    await prisma.project.create({ data: { id: projectId, name: 'Protected access project', organizationId } })
    await prisma.team.create({ data: { id: teamId, name: 'Protected access team', projectId } })
    await prisma.agent.createMany({ data: [
      // The canonical policy-target list deliberately includes a person's
      // system-managed PA even though generic agent administration hides it.
      {
        agentKind: 'personal_assistant', delegationMode: 'act_as_requesting_user', id: agentId,
        name: 'Target', organizationId, surfacePolicy: 'dm_only', systemManaged: true,
      },
      { id: foreignAgentId, name: 'Foreign target', organizationId: foreignOrganizationId },
    ] })
    await prisma.channel.create({ data: {
      id: privateChannelId, label: 'private connector channel', organization: { connect: { id: organizationId } },
      project: { connect: { id: projectId } }, team: { connect: { id: teamId } }, slug: `private-${randomUUID()}`, visibility: 'private',
    } })
    const personalAssistantChannel = await prisma.channel.create({ data: {
      dmKey: `pa:${organizationId}:${ownerUserId}`, id: personalAssistantChannelId, label: 'Personal Assistant',
      organization: { connect: { id: organizationId } }, project: { connect: { id: projectId } },
      team: { connect: { id: teamId } }, type: 'dm', visibility: 'private',
    } })
    await prisma.channelMember.create({ data: { channelId: personalAssistantChannel.id, userId: ownerUserId } })
    await prisma.agentBinding.create({ data: { agentId, channelId: personalAssistantChannel.id, principalUserId: ownerUserId } })

    const catalogue = await catalogEntry(prisma, { organizationId, userId: ownerUserId })
    const ownTool = await protectedMcpTool(prisma, { catalogEntryId: catalogue.id, installedBy: ownerUserId, label: 'Own private MCP', organizationId, scopeId: ownerUserId, scopeType: 'user' })
    const otherPrivateTool = await protectedMcpTool(prisma, { catalogEntryId: catalogue.id, installedBy: otherUserId, label: 'Other private MCP', organizationId, scopeId: otherUserId, scopeType: 'user' })
    const unjoinedChannelTool = await protectedMcpTool(prisma, { catalogEntryId: catalogue.id, installedBy: otherUserId, label: 'Unjoined channel MCP', organizationId, scopeId: privateChannelId, scopeType: 'channel' })
    const executorTool = await prisma.toolRegistryEntry.create({ data: {
      description: 'Executor controlled', handlerKind: 'builtin', label: 'Executor controlled', metadata: { requiresExplicitGrant: true }, organizationId,
      overview: 'Executor controlled', scopeKey: `executor-${randomUUID()}`, source: 'executor', status: 'active', toolId: `executor:${randomUUID()}`,
    } })

    const ownerContext = contextFor(prisma, { agentId, organizationId, userId: ownerUserId }, published)
    await prisma.organizationMember.update({ where: { organizationId_userId: { organizationId, userId: demotedUserId } }, data: { role: 'member' } })
    const demotedContext = contextFor(prisma, { agentId, organizationId, userId: demotedUserId }, published)
    assert.match(await refusal(runAgentToolAccessSetTool(demotedContext, { agentId, enabled: true, toolRegistryEntryId: ownTool.id })), /organisation owner/)
    assert.equal(await prisma.toolGrant.count({ where: { agentId } }), 0)

    assert.match(await refusal(runAgentToolAccessSetTool(ownerContext, { agentId: foreignAgentId, enabled: true, toolRegistryEntryId: ownTool.id })), /not an editable tool-policy target|not found/i)
    assert.match(await refusal(runAgentToolAccessSetTool(ownerContext, { agentId, enabled: true, toolRegistryEntryId: otherPrivateTool.id })), /outside your accessible scope/)
    assert.match(await refusal(runAgentToolAccessSetTool(ownerContext, { agentId, enabled: true, toolRegistryEntryId: unjoinedChannelTool.id })), /outside your accessible scope/)
    assert.match(await refusal(runAgentToolAccessSetTool(ownerContext, { agentId, enabled: true, toolRegistryEntryId: executorTool.id })), /Executors access controls/)
    assert.equal(await prisma.toolGrant.count({ where: { agentId } }), 0)

    const granted = await runAgentToolAccessSetTool(ownerContext, { agentId, enabled: true, toolRegistryEntryId: ownTool.id })
    assert.match(granted.outputPreview, /Granted protected tool access/)
    assert.deepEqual(published, [{
      event: 'agent.updated',
      scopes: [
        { kind: 'organization', organizationId },
        { agentId, kind: 'agent' },
      ],
    }])
    assert.equal(await prisma.auditLog.count({ where: { action: 'agent.tool_access.updated', organizationId, resourceId: agentId } }), 1)
    const current = await runAgentToolAccessInspectTool(ownerContext, { agentId })
    assert.match(current.outputPreview, /^- Own private MCP \| registryId=.+ \| granted$/m)
    assert.doesNotMatch(current.outputPreview, /Other private MCP|Unjoined channel MCP|Executor controlled/)

    await prisma.toolRegistryEntry.update({ where: { id: ownTool.id }, data: { description: 'Descriptor changed after grant' } })
    const stale = await runAgentToolAccessInspectTool(ownerContext, { agentId })
    assert.match(stale.outputPreview, /Own private MCP.*not granted/)
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [organizationId, foreignOrganizationId] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, demotedUserId, otherUserId] } } })
    await prisma.$disconnect()
  }
})
