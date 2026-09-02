import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerIntegrationProductRoutes } from '../src/routes/integrations/products.js'
import { getIntegrationPluginManifest } from '../src/services/integration-plugin-manifests.js'
import {
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
  deepWaterBundleMarkerKey,
} from '../src/services/deepwater-policy-markers.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const connectorId = '00000000-0000-4000-8000-000000000005'
const personalAssistantId = '00000000-0000-4000-8000-000000000006'
const sharedAgentId = '00000000-0000-4000-8000-000000000007'
const systemTeamId = '00000000-0000-4000-8000-000000000008'
const channelId = '00000000-0000-4000-8000-000000000009'
const threadId = '00000000-0000-4000-8000-000000000010'
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
  [DEEP_WATER_RUN_UPDATE_TOOL_ID, true] as const,
])

const makeMemberApp = () => {
  const actorContext: AuthorizedActionContext = {
    actionContext: { requestId: 'request-member-agent-access' },
    actor: { actorId: userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId, projectId, teamId },
  }
  const prisma = {
    agent: {
      findMany: async () => [
        {
          agentKind: 'personal_assistant',
          id: personalAssistantId,
          name: 'Personal Assistant',
          role: 'assistant',
          toolPolicy: policy,
        },
        {
          agentKind: 'shared',
          id: sharedAgentId,
          name: 'Shared Researcher',
          role: 'researcher',
          toolPolicy: policy,
        },
      ],
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
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
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerIntegrationProductRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: (_context, reply) => {
      void reply.code(403).send({ error: { code: 'FORBIDDEN' } })
      return false
    },
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerIntegrationProductRoutes>[1])
  return app
}

test('member Deep Water access GET exposes PA readiness but strips shared agents', async () => {
  const app = makeMemberApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/products/deep-water/agent-access',
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().data.personalAssistant.agentId, personalAssistantId)
    assert.equal(response.json().data.personalAssistant.enabled, true)
    assert.deepEqual(response.json().data.sharedAgents, [])
  } finally {
    await app.close()
  }
})

test('member Deep Water access PATCH is owner-only', async () => {
  const app = makeMemberApp()
  try {
    const response = await app.inject({
      method: 'PATCH',
      payload: { enabled: true, target: 'personal_assistant' },
      url: '/api/integrations/products/deep-water/agent-access',
    })

    assert.equal(response.statusCode, 403)
  } finally {
    await app.close()
  }
})

test('disabled integration still reports a retained bundle as revocable', async () => {
  const retainedPolicy = {
    [DEEP_WATER_RUN_UPDATE_TOOL_ID]: true,
    [deepWaterBundleMarkerKey(teamId)]: true,
  }
  const actorContext: AuthorizedActionContext = {
    actionContext: { requestId: 'request-disabled-access' },
    actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId, projectId, teamId },
  }
  const prisma = {
    agent: {
      findMany: async () => [{
        agentKind: 'personal_assistant',
        id: personalAssistantId,
        name: 'Personal Assistant',
        role: 'assistant',
        toolPolicy: retainedPolicy,
      }],
    },
    mcpServerInstance: { findFirst: async () => null },
    toolRegistryEntry: {
      findFirst: async () => ({
        enabled: true,
        status: 'active',
        toolId: DEEP_WATER_RUN_UPDATE_TOOL_ID,
      }),
      upsert: async () => ({}),
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerIntegrationProductRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerIntegrationProductRoutes>[1])
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/products/deep-water/agent-access',
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.data.configured, false)
    assert.equal(payload.data.personalAssistant.enabled, false)
    assert.equal(
      payload.data.personalAssistant.revocableGrantCount,
      1,
      JSON.stringify(payload),
    )
  } finally {
    await app.close()
  }
})

const makeOwnerBootstrapApp = () => {
  let personalAssistantExists = false
  let personalAssistantPolicy: Record<string, boolean> = {}
  const agentBindings: Array<{ agentId: string; channelId: string }> = []
  const db = {
    $executeRaw: async () => 0,
    agent: {
      create: async () => {
        personalAssistantExists = true
        return { id: personalAssistantId }
      },
      findFirst: async ({ select }: { select?: { id?: true } }) => {
        if (!personalAssistantExists) return null
        if (select && Object.keys(select).length === 1 && select.id) {
          return { id: personalAssistantId }
        }
        return {
          agentKind: 'personal_assistant',
          id: personalAssistantId,
          name: 'Personal Assistant',
          role: 'assistant',
          toolPolicy: personalAssistantPolicy,
        }
      },
      findMany: async () =>
        personalAssistantExists
          ? [{
              agentKind: 'personal_assistant',
              id: personalAssistantId,
              name: 'Personal Assistant',
              role: 'assistant',
              toolPolicy: personalAssistantPolicy,
            }]
          : [],
      update: async ({
        data,
      }: {
        data: { toolPolicy: Record<string, boolean> }
      }) => {
        personalAssistantPolicy = data.toolPolicy
        return {
          agentKind: 'personal_assistant',
          id: personalAssistantId,
          name: 'Personal Assistant',
          role: 'assistant',
          toolPolicy: personalAssistantPolicy,
        }
      },
    },
    team: {
      create: async () => ({ id: systemTeamId }),
      findFirst: async ({ where }: { where: { id?: string; name?: string } }) =>
        where.id ? { projectId } : null,
      findUnique: async () => ({
        project: { id: projectId, organizationId },
      }),
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
      findMany: async () => [],
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
    // PA bootstrap reconciles descriptor-bound protected grants independently
    // of the legacy bundle policy that this route asserts below.
    toolGrant: {
      create: async () => ({}),
      findMany: async () => [],
    },
  }
  const prisma = {
    ...db,
    $transaction: async <T>(action: (client: typeof db) => Promise<T>) =>
      action(db),
    agentBinding: {
      createMany: async (args: {
        data: Array<{ agentId: string; channelId: string }>
        skipDuplicates?: boolean
      }) => {
        let count = 0
        for (const binding of args.data) {
          const duplicate = agentBindings.some((row) =>
            row.agentId === binding.agentId && row.channelId === binding.channelId)
          if (duplicate) {
            if (args.skipDuplicates) continue
            throw new Error('agent binding pair must be unique')
          }
          agentBindings.push({ ...binding })
          count += 1
        }
        return { count }
      },
    },
    channel: { upsert: async () => ({ id: channelId }) },
    channelMember: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
    },
    thread: {
      create: async () => ({ id: threadId }),
      findFirst: async () => null,
    },
  } as unknown as PrismaClient
  const actorContext: AuthorizedActionContext = {
    actionContext: { requestId: 'request-owner-agent-access' },
    actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId, projectId, teamId },
  }
  const app = Fastify({ logger: false })
  registerIntegrationProductRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerIntegrationProductRoutes>[1])
  return {
    app,
    get personalAssistantExists() {
      return personalAssistantExists
    },
    get personalAssistantPolicy() {
      return personalAssistantPolicy
    },
    get agentBindings() {
      return agentBindings
    },
  }
}

test('owner grant bootstraps the Personal Assistant and grants the exact bundle', async () => {
  const state = makeOwnerBootstrapApp()
  try {
    const response = await state.app.inject({
      method: 'PATCH',
      payload: { enabled: true, target: 'personal_assistant' },
      url: '/api/integrations/products/deep-water/agent-access',
    })

    assert.equal(response.statusCode, 200)
    assert.equal(state.personalAssistantExists, true)
    assert.equal(response.json().data.personalAssistant.enabled, true)
    assert.equal(
      Object.values(state.personalAssistantPolicy).filter(Boolean).length,
      7,
    )
    assert.deepEqual(state.agentBindings, [{ agentId: personalAssistantId, channelId }])
  } finally {
    await state.app.close()
  }
})
