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
const projectedEntries =
  (getIntegrationPluginManifest('deep-water')?.mcp?.tools ?? [])
    .map((tool, index) => ({
      enabled: true,
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
      metadata: { requiresExplicitGrant: true },
      status: 'active',
      transportConfig: { toolName: tool.name },
    }))

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
  const actorContext: AuthorizedActionContext = {
    actionContext: { requestId: 'request-launch-route' },
    actor: { actorId: userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId, projectId, teamId },
  }
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
