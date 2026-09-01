import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
  mergeAgentToolPolicy,
  registryEntryPolicyKey,
  registryEntryRequiresExplicitPolicy,
  setAgentToolPolicyKeys,
} from '../src/services/agent-tool-policy.js'
import { setAgentToolPolicyForRegistryEntry } from '../src/services/agent-tool-policy-registry.js'
import {
  DEEP_WATER_MANUAL_UPDATER_MARKER,
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
  deepWaterBundleMarkerKey,
} from '../src/services/deepwater-policy-markers.js'

test('grant merges exact keys without replacing unrelated false verdicts', () => {
  assert.deepEqual(
    mergeAgentToolPolicy(
      {
        existing_allow: true,
        existing_deny: false,
      },
      ['deep_water_one', 'deep_water_two'],
      true,
    ),
    {
      deep_water_one: true,
      deep_water_two: true,
      existing_allow: true,
      existing_deny: false,
    },
  )
})

test('revoke removes only true grants and preserves explicit false verdicts', () => {
  assert.deepEqual(
    mergeAgentToolPolicy(
      {
        deep_water_one: true,
        deep_water_two: false,
        unrelated_deny: false,
      },
      ['deep_water_one', 'deep_water_two'],
      false,
    ),
    {
      deep_water_two: false,
      unrelated_deny: false,
    },
  )
})

test('registry policy keys use stable builtin ids and projected row ids', () => {
  const builtin = {
    handlerKind: 'builtin',
    id: 'registry-builtin',
    metadata: {},
    toolId: 'deep_water_run_update',
  }
  const projected = {
    handlerKind: 'mcp',
    id: 'registry-projected',
    metadata: { requiresExplicitGrant: true },
    toolId: 'mcp:instance:research_start',
  }

  assert.equal(registryEntryRequiresExplicitPolicy(builtin), true)
  assert.equal(registryEntryPolicyKey(builtin), 'deep_water_run_update')
  assert.equal(registryEntryRequiresExplicitPolicy(projected), true)
  assert.equal(registryEntryPolicyKey(projected), 'registry-projected')
})

type AgentFixture = {
  agentKind: 'personal_assistant' | 'shared'
  id: string
  name: string
  organizationId: string
  role: string
  systemManaged: boolean
  toolPolicy: Record<string, boolean>
}

const buildPolicyPrisma = (agent: AgentFixture) => {
  let lockCalls = 0
  let updateCalls = 0
  const tx = {
    $executeRaw: async () => {
      lockCalls += 1
      return 0
    },
    agent: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        where.id === agent.id && where.organizationId === agent.organizationId
          ? agent
          : null,
      update: async ({ data }: { data: { toolPolicy: Record<string, boolean> } }) => {
        updateCalls += 1
        agent.toolPolicy = data.toolPolicy
        return agent
      },
    },
    productIntegrationRun: {
      findFirst: async () => null,
    },
    toolRegistryEntry: {
      count: async () => 0,
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
    toolRegistryEntry: {
      findFirst: async () => ({
        handlerKind: 'builtin',
        id: 'registry-updater',
        metadata: { requiresExplicitGrant: true },
        toolId: DEEP_WATER_RUN_UPDATE_TOOL_ID,
      }),
    },
  } as unknown as PrismaClient
  return {
    get lockCalls() {
      return lockCalls
    },
    get updateCalls() {
      return updateCalls
    },
    get toolPolicy() {
      return agent.toolPolicy
    },
    prisma,
  }
}

test('targeted mutation serializes and preserves the rest of Agent.toolPolicy', async () => {
  const state = buildPolicyPrisma({
    agentKind: 'personal_assistant',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Personal Assistant',
    organizationId: '00000000-0000-4000-8000-000000000010',
    role: 'assistant',
    systemManaged: true,
    toolPolicy: {
      existing_allow: true,
      existing_deny: false,
    },
  })

  const target = await setAgentToolPolicyKeys(state.prisma, {
    agentId: '00000000-0000-4000-8000-000000000001',
    enabled: true,
    organizationId: '00000000-0000-4000-8000-000000000010',
    policyKeys: ['deep_water_one', 'deep_water_two'],
  })

  assert.equal(state.lockCalls, 1)
  assert.equal(state.updateCalls, 1)
  assert.deepEqual(target.toolPolicy, {
    deep_water_one: true,
    deep_water_two: true,
    existing_allow: true,
    existing_deny: false,
  })
})

test('targeted mutation rejects an agent outside the caller organization', async () => {
  const state = buildPolicyPrisma({
    agentKind: 'shared',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Researcher',
    organizationId: '00000000-0000-4000-8000-000000000020',
    role: 'researcher',
    systemManaged: false,
    toolPolicy: {},
  })

  await assert.rejects(
    () =>
      setAgentToolPolicyKeys(state.prisma, {
        agentId: '00000000-0000-4000-8000-000000000001',
        enabled: true,
        organizationId: '00000000-0000-4000-8000-000000000010',
        policyKeys: ['deep_water_one'],
      }),
    (error: unknown) =>
      error instanceof AgentToolPolicyError
      && error.code === AGENT_TOOL_POLICY_ERROR_CODES.AGENT_NOT_FOUND,
  )
  assert.equal(state.updateCalls, 0)
})

test('individual updater enable records manual provenance beside a bundle', async () => {
  const bundleMarker = deepWaterBundleMarkerKey(
    '00000000-0000-4000-8000-000000000030',
  )
  const state = buildPolicyPrisma({
    agentKind: 'personal_assistant',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Personal Assistant',
    organizationId: '00000000-0000-4000-8000-000000000010',
    role: 'assistant',
    systemManaged: true,
    toolPolicy: { [bundleMarker]: true },
  })

  const target = await setAgentToolPolicyForRegistryEntry(state.prisma, {
    agentId: '00000000-0000-4000-8000-000000000001',
    enabled: true,
    organizationId: '00000000-0000-4000-8000-000000000010',
    toolRegistryEntryId: '00000000-0000-4000-8000-000000000002',
  })

  assert.equal(target.toolPolicy[DEEP_WATER_RUN_UPDATE_TOOL_ID], true)
  assert.equal(target.toolPolicy[DEEP_WATER_MANUAL_UPDATER_MARKER], true)
  assert.equal(target.toolPolicy[bundleMarker], true)
})

test('individual updater disable is blocked while bundle provenance requires it', async () => {
  const bundleMarker = deepWaterBundleMarkerKey(
    '00000000-0000-4000-8000-000000000030',
  )
  const state = buildPolicyPrisma({
    agentKind: 'personal_assistant',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Personal Assistant',
    organizationId: '00000000-0000-4000-8000-000000000010',
    role: 'assistant',
    systemManaged: true,
    toolPolicy: {
      [bundleMarker]: true,
      [DEEP_WATER_MANUAL_UPDATER_MARKER]: true,
      [DEEP_WATER_RUN_UPDATE_TOOL_ID]: true,
    },
  })

  await assert.rejects(
    () =>
      setAgentToolPolicyForRegistryEntry(state.prisma, {
        agentId: '00000000-0000-4000-8000-000000000001',
        enabled: false,
        organizationId: '00000000-0000-4000-8000-000000000010',
        toolRegistryEntryId: '00000000-0000-4000-8000-000000000002',
      }),
    (error: unknown) =>
      error instanceof AgentToolPolicyError
      && error.code === AGENT_TOOL_POLICY_ERROR_CODES.DEPENDENCY_REQUIRED,
  )
  assert.equal(state.toolPolicy[DEEP_WATER_RUN_UPDATE_TOOL_ID], true)
  assert.equal(state.toolPolicy[DEEP_WATER_MANUAL_UPDATER_MARKER], true)
  assert.equal(state.toolPolicy[bundleMarker], true)
})

test('individual updater disable succeeds after dependencies are revoked', async () => {
  const state = buildPolicyPrisma({
    agentKind: 'personal_assistant',
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Personal Assistant',
    organizationId: '00000000-0000-4000-8000-000000000010',
    role: 'assistant',
    systemManaged: true,
    toolPolicy: {
      [DEEP_WATER_MANUAL_UPDATER_MARKER]: true,
      [DEEP_WATER_RUN_UPDATE_TOOL_ID]: true,
    },
  })

  const target = await setAgentToolPolicyForRegistryEntry(state.prisma, {
    agentId: '00000000-0000-4000-8000-000000000001',
    enabled: false,
    organizationId: '00000000-0000-4000-8000-000000000010',
    toolRegistryEntryId: '00000000-0000-4000-8000-000000000002',
  })

  assert.equal(target.toolPolicy[DEEP_WATER_RUN_UPDATE_TOOL_ID], undefined)
  assert.equal(target.toolPolicy[DEEP_WATER_MANUAL_UPDATER_MARKER], undefined)
})

test('individual Deep Water projection revoke blocks during an active run', async () => {
  const organizationId = '00000000-0000-4000-8000-000000000010'
  const teamId = '00000000-0000-4000-8000-000000000030'
  const agentId = '00000000-0000-4000-8000-000000000001'
  const registryId = '00000000-0000-4000-8000-000000000002'
  const agent = {
    agentKind: 'shared' as const,
    id: agentId,
    name: 'Researcher',
    organizationId,
    role: 'researcher',
    systemManaged: false,
    toolPolicy: { [registryId]: true },
  }
  let updateCalls = 0
  const entry = {
    handlerKind: 'mcp',
    id: registryId,
    metadata: { requiresExplicitGrant: true },
    mcpInstance: {
      catalogEntry: {
        integratedProducts: [{ slug: 'deep-water' }],
        name: 'deep-water',
        organizationId: null,
        visibility: 'public',
      },
      scopeId: teamId,
      scopeType: 'team',
    },
    toolId: 'mcp:deep-water:research_start',
  }
  const tx = {
    $executeRaw: async () => 0,
    agent: {
      findFirst: async () => agent,
      update: async () => {
        updateCalls += 1
        return agent
      },
    },
    productIntegrationRun: {
      findFirst: async () => ({
        channelId: '00000000-0000-4000-8000-000000000040',
        id: '00000000-0000-4000-8000-000000000050',
        status: 'queued',
      }),
    },
    toolRegistryEntry: {
      findFirst: async () => entry,
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
    toolRegistryEntry: {
      findFirst: async () => entry,
    },
  } as unknown as PrismaClient

  await assert.rejects(
    () =>
      setAgentToolPolicyForRegistryEntry(prisma, {
        agentId,
        enabled: false,
        organizationId,
        toolRegistryEntryId: registryId,
      }),
    (error: unknown) =>
      error instanceof AgentToolPolicyError
      && error.code === AGENT_TOOL_POLICY_ERROR_CODES.ACTIVE_RUNS,
  )
  assert.equal(updateCalls, 0)
  assert.equal(agent.toolPolicy[registryId], true)
})
