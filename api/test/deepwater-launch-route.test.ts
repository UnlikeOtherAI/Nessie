import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  RunExecuteJobPayload,
} from '@nessie/schemas'
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
const wrongFreshRunId = '22222222-2222-4222-8222-222222222222'
const paRunId = '33333333-3333-4333-8333-333333333333'
const paTaskId = '44444444-4444-4444-8444-444444444444'
const projectedEntries =
  (getIntegrationPluginManifest('deep-water')?.mcp?.tools ?? [])
    .map((tool, index) => ({
      enabled: true,
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
      metadata: { requiresExplicitGrant: true },
      status: 'active',
      transportConfig: { toolName: tool.name },
    }))
const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'request-launch-route' },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId, projectId, teamId },
}

test('research-launch route returns 409 before run creation when PA has 5-of-6', async () => {
  let runCreateCalls = 0
  const policy = Object.fromEntries([
    ...projectedEntries.slice(1).map((entry) => [entry.id, true] as const),
    [DEEP_WATER_RUN_UPDATE_TOOL_ID, true] as const,
  ])
  const tx = {
    $executeRaw: async () => 0,
    agent: {
      findFirst: async () => ({ id: agentId }),
      findUnique: async () => ({ toolPolicy: policy }),
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
    },
    productIntegrationRun: {
      create: async () => {
        runCreateCalls += 1
        return {}
      },
    },
    productTeamEnablement: {
      findUnique: async () => ({ enabled: true }),
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
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerIntegrationHandoffRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerIntegrationHandoffRoutes>[1])

  try {
    const response = await app.inject({
      method: 'POST',
      payload: { query: 'Research authorization boundary' },
      url: '/api/integrations/products/deep-water/research-launch',
    })

    assert.equal(response.statusCode, 409)
    assert.equal(
      response.json().error.code,
      'DEEP_WATER_PERSONAL_ASSISTANT_ACCESS_REQUIRED',
    )
    assert.equal(runCreateCalls, 0)
  } finally {
    await app.close()
  }
})

test('research-launch persists and enqueues the exact full created durable run id', async () => {
  const now = new Date('2026-07-19T20:00:00.000Z')
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
  const attachedRunRow = {
    ...baseRunRow,
    channel_id: channelId,
    message_id: messageId,
    thread_id: threadId,
  }
  const rawQueryValues: unknown[][] = []
  let rawQueryCalls = 0
  let persistedContent = ''
  let persistedMetadata: Record<string, unknown> = {}
  let enqueuedPayload: RunExecuteJobPayload | undefined
  let enqueuedKey = ''
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (query: { values?: unknown[] }) => {
      rawQueryValues.push(query.values ?? [])
      rawQueryCalls += 1
      return [rawQueryCalls === 1 ? baseRunRow : attachedRunRow]
    },
    agent: {
      findFirst: async () => ({ id: agentId }),
      findUnique: async () => ({
        id: agentId,
        name: 'Personal Assistant',
        role: 'assistant',
        systemPrompt: 'Help',
        toolPolicy: policy,
      }),
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
    },
    message: {
      create: async (input: {
        data: {
          content: string
          metadata: Record<string, unknown>
        }
      }) => {
        persistedContent = input.data.content
        persistedMetadata = input.data.metadata
        return {
          agentId: null,
          content: input.data.content,
          createdAt: now,
          deletedAt: null,
          editedAt: null,
          id: messageId,
          metadata: input.data.metadata,
          basisScopes: [],
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
      create: async () => ({
        agentId,
        id: paRunId,
        threadId,
      }),
    },
    task: {
      create: async () => ({ id: paTaskId }),
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
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
    agent: tx.agent,
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerIntegrationHandoffRoutes(app, {
    buildChannelRealtimeScopes: () => [],
    enqueue: async (
      _tx: unknown,
      payload: RunExecuteJobPayload,
      idempotencyKey?: string,
    ) => {
      enqueuedPayload = payload
      enqueuedKey = idempotencyKey ?? ''
      return true
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
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => actorContext,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerIntegrationHandoffRoutes>[1])

  try {
    const response = await app.inject({
      method: 'POST',
      payload: { query: 'Trace Swift @MainActor migration.' },
      url: '/api/integrations/products/deep-water/research-launch',
    })

    assert.equal(response.statusCode, 202)
    assert.equal(enqueuedPayload?.messageId, messageId)
    assert.equal(enqueuedPayload?.runId, paRunId)
    assert.equal(enqueuedPayload?.taskId, paTaskId)
    assert.equal(enqueuedPayload?.agentId, agentId)
    assert.equal(enqueuedPayload?.interactive, true)
    assert.equal(enqueuedKey, `run:${messageId}:${agentId}`)
    assert.deepEqual(enqueuedPayload?.actorContext, {
      ...actorContext,
      actionContext: {
        ...actorContext.actionContext,
        agentId,
        channelId,
        effectiveUserId: userId,
        taskId: paTaskId,
        threadId,
      },
    })

    const lines = persistedContent.split('\n')
    const runLabelIndex = lines.indexOf(
      'Nessie durable research run id (use this exact full UUID for every deep_water_run_update call):',
    )
    assert.notEqual(runLabelIndex, -1)
    const handedOffRunId = lines[runLabelIndex + 1]
    assert.equal(handedOffRunId, durableRunId)
    assert.notEqual(handedOffRunId, connectorId)
    assert.notEqual(handedOffRunId, wrongFreshRunId)
    assert.notEqual(handedOffRunId, durableRunId.slice(0, 8))
    assert.equal(lines.includes(durableRunId.slice(0, 8)), false)
    assert.equal(persistedContent.includes(connectorId), false)
    assert.equal(persistedContent.includes(wrongFreshRunId), false)

    const integrationLaunch = persistedMetadata.integrationLaunch as {
      connectorId: string
      runId: string
    }
    assert.equal(integrationLaunch.connectorId, connectorId)
    assert.equal(integrationLaunch.runId, durableRunId)
    const card = (persistedMetadata.uiCards as Array<{
      fields: Array<{ label: string; value: string }>
    }>)[0]
    assert.equal(
      card?.fields.find((field) => field.label === 'Run')?.value,
      durableRunId.slice(0, 8),
    )

    assert.equal(rawQueryCalls, 2)
    assert.equal(rawQueryValues[1]?.includes(durableRunId), true)
    assert.equal(rawQueryValues[1]?.includes(connectorId), false)
    assert.equal(rawQueryValues[1]?.includes(wrongFreshRunId), false)

    const body = response.json() as {
      data: {
        message: { content: string; id: string }
        run: {
          channelId: string
          id: string
          messageId: string
          threadId: string
        }
      }
    }
    assert.equal(body.data.message.id, messageId)
    assert.equal(body.data.message.content, persistedContent)
    assert.equal(body.data.run.id, durableRunId)
    assert.equal(body.data.run.channelId, channelId)
    assert.equal(body.data.run.threadId, threadId)
    assert.equal(body.data.run.messageId, messageId)
  } finally {
    await app.close()
  }
})
