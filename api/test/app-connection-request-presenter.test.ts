import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
} from '@nessie/mcp-manage'

import { getAppConnectionRequestPresenter } from '../src/services/app-connection-request-presenter.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const otherUserId = '00000000-0000-4000-8000-000000000003'
const agentId = '00000000-0000-4000-8000-000000000004'
const channelId = '00000000-0000-4000-8000-000000000005'
const requestId = '00000000-0000-4000-8000-000000000006'
const appId = '00000000-0000-4000-8000-000000000007'

const actorContextFor = (actorId: string): AuthorizedActionContext => ({
  actionContext: { requestId: `request-${actorId}` },
  actor: { actorId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId },
} as unknown as AuthorizedActionContext)

const requestRow = {
  agent: {
    agentKind: 'personal_assistant',
    bindings: [{ channelId }],
    id: agentId,
    systemManaged: true,
    toolPolicy: {},
  },
  agentId,
  candidateCatalogEntryIds: [appId],
  consentSnapshot: {
    agent: { id: agentId, name: 'Personal Assistant' },
    candidates: [{
      authMethod: 'oauth2',
      capabilityCount: 67,
      catalogEntryId: appId,
      displayName: 'Linear',
      iconUrl: '/api/apps/icons/linear',
      shortDescription: 'Project planning and issue tracking',
      trustLevel: 'verified',
    }],
    scope: { label: 'Only you', scopeId: userId, scopeType: 'user' },
  },
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  failureCode: null,
  id: requestId,
  mcpInstance: null,
  organization: { conversationalSetupEnabled: true },
  requestedByUser: { organizationMembers: [{ id: 'membership' }] },
  selectedCatalogEntryId: null,
  status: 'offered',
  thread: {
    channel: {
      dmKey: `pa:${organizationId}:${userId}`,
      id: channelId,
      members: [{ userId }],
      systemChannelType: 'personal_assistant',
    },
  },
} as const

const makePrisma = (row = requestRow, grants: Array<{
  config: unknown
  state: string
  toolId: string
}> = []) => ({
  agentAppConnectionRequest: {
    findFirst: async ({ where }: { where: { requestedByUserId: string } }) =>
      where.requestedByUserId === userId ? row : null,
  },
  toolGrant: { findMany: async () => grants },
}) as unknown as PrismaClient

test('the card presenter gives its requester only the safe, immutable app choice', async () => {
  const presenter = await getAppConnectionRequestPresenter(
    makePrisma(),
    actorContextFor(userId),
    requestId,
  )

  assert.deepEqual(presenter, {
    action: 'begin',
    agent: { id: agentId, name: 'Personal Assistant' },
    candidates: [requestRow.consentSnapshot.candidates[0]],
    detail: null,
    expiresAt: requestRow.expiresAt.toISOString(),
    failureCode: null,
    requestId,
    scope: { label: 'Only you', scopeType: 'user' },
    selectedCatalogEntryId: null,
    status: 'offered',
  })
  assert.doesNotMatch(JSON.stringify(presenter), /credential|authorization|instance|account/i)
})

test('the presenter is indistinguishable from absent for another user', async () => {
  const presenter = await getAppConnectionRequestPresenter(
    makePrisma(),
    actorContextFor(otherUserId),
    requestId,
  )

  assert.equal(presenter, null)
})

test('an active app is ready only while the Personal Assistant keeps its app access', async () => {
  const registryEntryId = '00000000-0000-4000-8000-000000000008'
  const tool = {
    description: 'Create a Linear issue.',
    id: registryEntryId,
    inputSchema: { type: 'object' },
    metadata: { requiresExplicitGrant: true },
    outputSchema: null,
    toolId: 'mcp:linear:create_issue',
    transportConfig: { toolName: 'create_issue' },
  }
  const connectedRow = {
    ...requestRow,
    agent: { ...requestRow.agent, toolPolicy: {} },
    mcpInstance: { lifecycleState: 'active', toolRegistryEntries: [tool] },
    selectedCatalogEntryId: appId,
    status: 'connecting' as const,
  }
  const descriptorFingerprint = fingerprintMcpToolDescriptor({
    annotations: {},
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: 'create_issue',
    outputSchema: tool.outputSchema,
  })

  const ready = await getAppConnectionRequestPresenter(
    makePrisma(connectedRow, [{
      config: { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: descriptorFingerprint },
      state: 'allowed',
      toolId: registryEntryId,
    }]),
    actorContextFor(userId),
    requestId,
  )
  const revoked = await getAppConnectionRequestPresenter(
    makePrisma(connectedRow, [{ config: {}, state: 'denied', toolId: registryEntryId }]),
    actorContextFor(userId),
    requestId,
  )

  assert.equal(ready?.status, 'ready')
  assert.equal(ready?.detail, null)
  assert.equal(revoked?.status, 'awaiting_grant')
  assert.equal(revoked?.detail, 'Connected, but Personal Assistant access is switched off in App Management.')
})
