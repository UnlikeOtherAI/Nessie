import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerIntegrationHandoffRoutes } from '../src/routes/integrations/handoffs.js'
import { getIntegrationPluginManifest } from '../src/services/integration-plugin-manifests.js'
import { DEEP_WATER_RUN_UPDATE_TOOL_ID } from '../src/services/deepwater-policy-markers.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const agentId = '00000000-0000-4000-8000-000000000005'
const connectorId = '00000000-0000-4000-8000-000000000006'
const channelId = '00000000-0000-4000-8000-000000000007'
const threadId = '00000000-0000-4000-8000-000000000008'
const messageId = '00000000-0000-4000-8000-000000000009'
const durableRunId = '11111111-1111-4111-8111-111111111111'
const paRunId = '22222222-2222-4222-8222-222222222222'
const paTaskId = '33333333-3333-4333-8333-333333333333'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-launch-dispatch-failure' },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
}

test('enqueue collision rolls back the PA handoff and fails the exact DeepWater run', async () => {
  const now = new Date('2026-07-20T08:00:00.000Z')
  const projectedEntries =
    (getIntegrationPluginManifest('deep-water')?.mcp?.tools ?? [])
      .map((tool, index) => ({
        enabled: true,
        id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
        metadata: { requiresExplicitGrant: true },
        status: 'active',
        transportConfig: { toolName: tool.name },
      }))
  const policy = Object.fromEntries([
    ...projectedEntries.map((entry) => [entry.id, true] as const),
    [DEEP_WATER_RUN_UPDATE_TOOL_ID, true],
  ])
  const baseRunRow = {
    channel_id: null,
    completed_at: null,
    connector_id: connectorId,
    created_at: now,
    external_run_id: null,
    id: durableRunId,
    input_json: {
      artifactDestination: 'knowledge_draft',
      depth: 'standard',
      outputTier: 'full',
      searchQuality: 'standard',
    },
    knowledge_page_id: null,
    message_id: null,
    organization_id: organizationId,
    product_slug: 'deep-water',
    query_preview: 'Trace Swift @MainActor migration.',
    requested_at: now,
    requested_by_user_id: userId,
    result_json: {},
    source_count: null,
    status: 'queued',
    team_id: teamId,
    thread_id: null,
    title: null,
    updated_at: now,
  }

  const messages: string[] = []
  const paRuns: string[] = []
  const paTasks: string[] = []
  let enqueueAttempts = 0
  let handoffAttached = false
  let productStatus: 'failed' | 'queued' | null = null
  let realtimeCalls = 0
  let failedMutationSql = ''
  let failedMutationValues: unknown[] = []

  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => {
      if (productStatus === null) {
        productStatus = 'queued'
        return [baseRunRow]
      }
      handoffAttached = true
      return [{
        ...baseRunRow,
        channel_id: channelId,
        message_id: messageId,
        thread_id: threadId,
      }]
    },
    agent: {
      findFirst: async () => ({ id: agentId }),
      findUnique: async () => ({ id: agentId, toolPolicy: policy }),
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
    },
    message: {
      create: async (input: { data: { content: string; metadata: unknown } }) => {
        messages.push(messageId)
        return {
          agentId: null,
          content: input.data.content,
          createdAt: now,
          deletedAt: null,
          editedAt: null,
          id: messageId,
          metadata: input.data.metadata,
          reactions: [],
          role: 'user',
          threadId,
          user: {
            avatarAttachmentId: null,
            avatarUrl: null,
            displayName: 'Researcher',
            email: 'researcher@example.com',
            id: userId,
          },
          userId,
        }
      },
    },
    productTeamEnablement: {
      findUnique: async () => ({ enabled: true }),
    },
    run: {
      create: async () => {
        paRuns.push(paRunId)
        return { agentId, id: paRunId, threadId }
      },
    },
    task: {
      create: async () => {
        paTasks.push(paTaskId)
        return { id: paTaskId }
      },
    },
    toolRegistryEntry: {
      findFirst: async () => ({
        enabled: true,
        status: 'active',
        toolId: DEEP_WATER_RUN_UPDATE_TOOL_ID,
      }),
      findMany: async () => projectedEntries,
      upsert: async () => ({}),
    },
  }
  const prisma = {
    $executeRaw: async (query: {
      strings?: readonly string[]
      values?: unknown[]
    }) => {
      failedMutationSql = query.strings?.join('?') ?? ''
      failedMutationValues = query.values ?? []
      productStatus = 'failed'
      return 1
    },
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => {
      const snapshot = {
        handoffAttached,
        messages: messages.length,
        paRuns: paRuns.length,
        paTasks: paTasks.length,
        productStatus,
      }
      try {
        return await action(tx)
      } catch (error) {
        handoffAttached = snapshot.handoffAttached
        messages.splice(snapshot.messages)
        paRuns.splice(snapshot.paRuns)
        paTasks.splice(snapshot.paTasks)
        productStatus = snapshot.productStatus
        throw error
      }
    },
    agent: tx.agent,
  } as unknown as PrismaClient

  const app = Fastify({ logger: false })
  registerIntegrationHandoffRoutes(app, {
    buildChannelRealtimeScopes: () => [],
    enqueue: async () => {
      enqueueAttempts += 1
      return false
    },
    ensureBootstrap: async () => ({ agentId, channelId, threadId }),
    isPersonalAssistantChannelType: (
      value: string | null | undefined,
    ): value is 'personal_assistant' => value === 'personal_assistant',
    loadPersonalAssistantState: async () => ({
      agent: { id: agentId },
      channel: {
        archivedAt: null,
        createdAt: now.toISOString(),
        defaultThreadId: threadId,
        description: null,
        dmUserId: userId,
        id: channelId,
        label: 'Personal Assistant',
        memberRole: 'member',
        organizationId,
        projectId,
        projectName: 'Project',
        slug: null,
        systemChannelType: 'personal_assistant',
        teamId,
        teamName: 'Team',
        topic: null,
        type: 'dm',
        unreadCount: 0,
        lastMessageAt: null,
        updatedAt: now.toISOString(),
        visibility: 'private',
      },
      thread: {
        channelId,
        createdAt: now.toISOString(),
        id: threadId,
        title: 'Default',
        updatedAt: now.toISOString(),
      },
    }),
    prisma,
    realtimeHub: {
      publishWs: async () => {
        realtimeCalls += 1
      },
    },
    requireActorContext: () => actorContext,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerIntegrationHandoffRoutes>[1])

  try {
    const response = await app.inject({
      method: 'POST',
      payload: { query: 'Trace Swift @MainActor migration.' },
      url: '/api/integrations/products/deep-water/research-launch',
    })

    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error.code, 'PERSONAL_ASSISTANT_UNAVAILABLE')
    assert.equal(enqueueAttempts, 1)
    assert.deepEqual(messages, [])
    assert.deepEqual(paRuns, [])
    assert.deepEqual(paTasks, [])
    assert.equal(handoffAttached, false)
    assert.equal(realtimeCalls, 0)
    assert.equal(productStatus, 'failed')
    assert.match(failedMutationSql, /"status" = 'failed'/)
    assert.equal(failedMutationValues.includes(durableRunId), true)
    assert.equal(failedMutationValues.includes(organizationId), true)
    assert.equal(failedMutationValues.includes(paRunId), false)
  } finally {
    await app.close()
  }
})
