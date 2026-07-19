import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES,
  DeepWaterLaunchAuthorizationError,
  runWithAuthorizedDeepWaterLaunch,
} from '../src/services/deepwater-launch-authorization.js'
import { getIntegrationPluginManifest } from '../src/services/integration-plugin-manifests.js'
import { DEEP_WATER_RUN_UPDATE_TOOL_ID } from '../src/services/deepwater-policy-markers.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const teamId = '00000000-0000-4000-8000-000000000002'
const agentId = '00000000-0000-4000-8000-000000000003'
const connectorId = '00000000-0000-4000-8000-000000000004'
const toolNames =
  getIntegrationPluginManifest('deep-water')?.mcp?.tools.map((tool) => tool.name)
  ?? []
const projectedEntries = toolNames.map((toolName, index) => ({
  enabled: true,
  id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
  metadata: { requiresExplicitGrant: true },
  status: 'active',
  transportConfig: { toolName },
}))

const buildPrisma = (
  missingPolicyKey?: string,
  builtinState: { enabled: boolean; status: string } = {
    enabled: true,
    status: 'active',
  },
) => {
  const events: string[] = []
  const policy = Object.fromEntries([
    ...projectedEntries.map((entry) => [entry.id, true] as const),
    [DEEP_WATER_RUN_UPDATE_TOOL_ID, true] as const,
  ])
  if (missingPolicyKey) delete policy[missingPolicyKey]

  const tx = {
    $executeRaw: async () => {
      events.push(events.length === 0 ? 'team-lock' : 'agent-lock')
      return 0
    },
    agent: {
      findFirst: async () => ({ id: agentId }),
      findUnique: async () => ({ toolPolicy: policy }),
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
    },
    productTeamEnablement: {
      findUnique: async () => ({ enabled: true }),
    },
    toolRegistryEntry: {
      findFirst: async ({
        where,
      }: {
        where: { enabled?: boolean; status?: string }
      }) => {
        if (
          where.enabled !== undefined
          && where.enabled !== builtinState.enabled
        ) {
          return null
        }
        if (
          where.status !== undefined
          && where.status !== builtinState.status
        ) {
          return null
        }
        return {
          ...builtinState,
          toolId: DEEP_WATER_RUN_UPDATE_TOOL_ID,
        }
      },
      findMany: async () => projectedEntries,
      upsert: async () => ({}),
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
  } as unknown as PrismaClient
  return { events, prisma }
}

test('launch locks team then policy and inserts only after a final 6-of-6 check', async () => {
  const state = buildPrisma()
  const result = await runWithAuthorizedDeepWaterLaunch(
    state.prisma,
    { organizationId, teamId },
    async (_tx, resolvedConnectorId) => {
      state.events.push('run-insert')
      return resolvedConnectorId
    },
  )

  assert.equal(result, connectorId)
  assert.deepEqual(state.events, ['team-lock', 'agent-lock', 'run-insert'])
})

test('launch rejects 5-of-6 without invoking the run insertion action', async () => {
  const state = buildPrisma(projectedEntries[0]!.id)
  let actionCalls = 0

  await assert.rejects(
    () =>
      runWithAuthorizedDeepWaterLaunch(
        state.prisma,
        { organizationId, teamId },
        async () => {
          actionCalls += 1
        },
      ),
    (error: unknown) =>
      error instanceof DeepWaterLaunchAuthorizationError
      && error.code
        === DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES.ACCESS_REQUIRED,
  )
  assert.equal(actionCalls, 0)
  assert.deepEqual(state.events, ['team-lock', 'agent-lock'])
})

test('launch rejects a granted updater builtin that is disabled in the registry', async () => {
  const state = buildPrisma(undefined, {
    enabled: false,
    status: 'active',
  })
  let actionCalls = 0

  await assert.rejects(
    () =>
      runWithAuthorizedDeepWaterLaunch(
        state.prisma,
        { organizationId, teamId },
        async () => {
          actionCalls += 1
        },
      ),
    (error: unknown) =>
      error instanceof DeepWaterLaunchAuthorizationError
      && error.code
        === DEEP_WATER_LAUNCH_AUTHORIZATION_ERROR_CODES.ACCESS_REQUIRED,
  )
  assert.equal(actionCalls, 0)
  assert.deepEqual(state.events, ['team-lock', 'agent-lock'])
})
