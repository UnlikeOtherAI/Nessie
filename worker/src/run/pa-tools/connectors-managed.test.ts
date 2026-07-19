import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runConnectorUninstallTool } from './connectors.js'

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333'
const CATALOG_ID = '44444444-4444-4444-8444-444444444444'

const createContext = (managed: boolean) => {
  const mutations = {
    instanceDelete: 0,
    registryDelete: 0,
    transaction: 0,
  }
  const prisma = {
    channelMember: { findMany: async () => [] },
    mcpServerInstance: {
      delete: async () => {
        mutations.instanceDelete += 1
        return {}
      },
      findFirst: async () => ({
        catalogEntry: managed
          ? {
              integratedProducts: [{ slug: 'deep-water' }],
              name: 'deep-water',
              visibility: 'public',
            }
          : null,
        catalogEntryId: CATALOG_ID,
        id: INSTANCE_ID,
        organizationId: ORGANIZATION_ID,
        scopeId: ORGANIZATION_ID,
        scopeType: 'organization',
      }),
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'owner' }),
    },
    projectMember: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
    toolRegistryEntry: {
      deleteMany: async () => {
        mutations.registryDelete += 1
        return { count: 1 }
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => {
      mutations.transaction += 1
      return Promise.all(operations)
    },
  }
  const context = {
    actorContext: {
      actionContext: { effectiveUserId: USER_ID, requestId: 'managed-uninstall' },
      actor: { actorId: 'assistant-agent', actorType: 'agent' },
      tenant: { organizationId: ORGANIZATION_ID },
    },
    agentId: 'assistant-agent',
    agentKind: 'personal_assistant',
    channel: { id: 'channel-1', organizationId: ORGANIZATION_ID },
    prisma,
    realtimeTransport: {},
    run: {
      id: 'run-1',
      messageId: 'message-1',
      threadId: 'thread-1',
    },
  } as unknown as BuiltinToolRuntimeContext

  return { context, mutations }
}

test('connector_uninstall leaves integration-managed DeepWater to its team toggle', async () => {
  const { context, mutations } = createContext(true)

  const result = await runConnectorUninstallTool(context, {
    instanceId: INSTANCE_ID,
  })

  assert.match(result.outputPreview, /managed from Integrations/)
  assert.deepEqual(mutations, {
    instanceDelete: 0,
    registryDelete: 0,
    transaction: 0,
  })
})

test('connector_uninstall still removes an ordinary connector', async () => {
  const { context, mutations } = createContext(false)

  const result = await runConnectorUninstallTool(context, {
    instanceId: INSTANCE_ID,
  })

  assert.match(result.outputPreview, /Connector uninstalled/)
  assert.deepEqual(mutations, {
    instanceDelete: 1,
    registryDelete: 1,
    transaction: 1,
  })
})
