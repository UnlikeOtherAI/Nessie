import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  DEEP_WATER_AGENT_ACCESS_ERROR_CODES,
  DEEP_WATER_REQUIRED_TOOL_COUNT,
  DeepWaterAgentAccessError,
  resolveDeepWaterPolicyKeys,
  resolveDeepWaterRevocationPolicyKeys,
  setDeepWaterAgentAccess,
} from '../src/services/deepwater-agent-access.js'
import {
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
  deepWaterBundleMarkerKey,
} from '../src/services/deepwater-policy-markers.js'

const names = [
  'research_start',
  'research_status',
  'research_report',
  'research_list',
  'research_cancel',
]

const projectedEntries = names.map((toolName, index) => ({
  id: `registry-${index + 1}`,
  metadata: { requiresExplicitGrant: true },
  transportConfig: { toolName },
}))

test('Deep Water access resolves the exact five projections plus updater builtin', () => {
  const resolved = resolveDeepWaterPolicyKeys({
    builtinPolicyKey: 'deep_water_run_update',
    projectedEntries,
  })

  assert.equal(DEEP_WATER_REQUIRED_TOOL_COUNT, 6)
  assert.equal(resolved.configured, true)
  assert.deepEqual(resolved.policyKeys, [
    'registry-1',
    'registry-2',
    'registry-3',
    'registry-4',
    'registry-5',
    'deep_water_run_update',
  ])
})

test('missing, duplicate, or non-explicit projections cannot satisfy readiness', () => {
  const resolved = resolveDeepWaterPolicyKeys({
    builtinPolicyKey: 'deep_water_run_update',
    projectedEntries: [
      ...projectedEntries.slice(0, 4),
      {
        id: 'duplicate',
        metadata: { requiresExplicitGrant: true },
        transportConfig: { toolName: 'research_start' },
      },
      {
        id: 'not-explicit',
        metadata: {},
        transportConfig: { toolName: 'research_cancel' },
      },
    ],
  })

  assert.equal(resolved.configured, false)
  assert.equal(resolved.policyKeys.length, 5)
})

test('the updater builtin is mandatory even when every MCP projection exists', () => {
  const resolved = resolveDeepWaterPolicyKeys({
    builtinPolicyKey: null,
    projectedEntries,
  })

  assert.equal(resolved.configured, false)
  assert.equal(resolved.policyKeys.length, 5)
})

test('an extra active projection cannot be mistaken for the exact contract', () => {
  const resolved = resolveDeepWaterPolicyKeys({
    builtinPolicyKey: 'deep_water_run_update',
    projectedEntries: [
      ...projectedEntries,
      {
        id: 'unexpected',
        metadata: { requiresExplicitGrant: true },
        transportConfig: { toolName: 'research_debug' },
      },
    ],
  })

  assert.equal(resolved.configured, false)
  assert.equal(resolved.revocationPolicyKeys.length, 7)
})

test('revoking one team preserves the shared updater needed by another team', () => {
  const teamAKeys = projectedEntries.map((entry) => entry.id)
  const teamBEntries = projectedEntries.map((entry, index) => ({
    ...entry,
    id: `team-b-${index + 1}`,
  }))
  const currentPolicy = Object.fromEntries([
    ...teamAKeys.map((policyKey) => [policyKey, true]),
    [teamBEntries[0]!.id, true],
    ['deep_water_run_update', true],
    [deepWaterBundleMarkerKey('team-a'), true],
  ])

  const revokeKeys = resolveDeepWaterRevocationPolicyKeys({
    builtinPolicyKey: 'deep_water_run_update',
    currentPolicy,
    currentRevocationPolicyKeys: [
      ...teamAKeys,
      'deep_water_run_update',
    ],
    currentTeamId: 'team-a',
    otherTeamBundles: [{
      projectedEntries: teamBEntries,
      teamId: 'team-b',
    }],
  })

  assert.deepEqual(revokeKeys, [
    ...teamAKeys,
    deepWaterBundleMarkerKey('team-a'),
  ])
  assert.equal(revokeKeys.includes('deep_water_run_update'), false)
})

test('the last bundle owner can revoke its updater allow', () => {
  const marker = deepWaterBundleMarkerKey('team-a')
  const revokeKeys = resolveDeepWaterRevocationPolicyKeys({
    builtinPolicyKey: 'deep_water_run_update',
    currentPolicy: {
      deep_water_run_update: true,
      [marker]: true,
    },
    currentRevocationPolicyKeys: ['deep_water_run_update'],
    currentTeamId: 'team-a',
    otherTeamBundles: [],
  })

  assert.deepEqual(revokeKeys, ['deep_water_run_update', marker])
})

test('partial or drifted current-team projections remain revocable', () => {
  const partialKeys = [
    projectedEntries[0]!.id,
    projectedEntries[1]!.id,
    'unexpected-projection',
    'deep_water_run_update',
  ]
  const revokeKeys = resolveDeepWaterRevocationPolicyKeys({
    builtinPolicyKey: 'deep_water_run_update',
    currentPolicy: Object.fromEntries(
      partialKeys.map((policyKey) => [policyKey, true]),
    ),
    currentRevocationPolicyKeys: partialKeys,
    currentTeamId: 'team-a',
    otherTeamBundles: [],
  })

  assert.deepEqual(revokeKeys, [
    ...partialKeys.filter((key) => key !== 'deep_water_run_update'),
    deepWaterBundleMarkerKey('team-a'),
  ])
})

const organizationId = '00000000-0000-4000-8000-000000000010'
const teamId = '00000000-0000-4000-8000-000000000011'
const agentId = '00000000-0000-4000-8000-000000000012'
const connectorId = '00000000-0000-4000-8000-000000000013'
const runId = '00000000-0000-4000-8000-000000000014'
const channelId = '00000000-0000-4000-8000-000000000015'
const liveEntries = names.map((toolName, index) => ({
  enabled: true,
  id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
  metadata: { requiresExplicitGrant: true },
  status: 'active',
  transportConfig: { toolName },
}))

const buildAccessPrisma = (
  activeRun: boolean,
  initialBuiltinState: { enabled: boolean; status: string } = {
    enabled: true,
    status: 'active',
  },
) => {
  const events: string[] = []
  const builtinState = { ...initialBuiltinState }
  let policy: Record<string, boolean> = Object.fromEntries([
    ...liveEntries.map((entry) => [entry.id, true] as const),
    [DEEP_WATER_RUN_UPDATE_TOOL_ID, true] as const,
    [deepWaterBundleMarkerKey(teamId), true] as const,
  ])
  let updateCalls = 0
  const tx = {
    $executeRaw: async () => {
      events.push(events.length === 0 ? 'team-lock' : 'agent-lock')
      return 0
    },
    agent: {
      findFirst: async () => ({
        agentKind: 'personal_assistant',
        id: agentId,
        name: 'Personal Assistant',
        role: 'assistant',
        toolPolicy: policy,
      }),
      update: async ({ data }: { data: { toolPolicy: Record<string, boolean> } }) => {
        updateCalls += 1
        policy = data.toolPolicy
        events.push('policy-update')
        return {
          agentKind: 'personal_assistant',
          id: agentId,
          name: 'Personal Assistant',
          role: 'assistant',
          toolPolicy: policy,
        }
      },
    },
    mcpServerInstance: {
      findFirst: async () => ({ id: connectorId }),
      findMany: async () => [],
    },
    productIntegrationRun: {
      findFirst: async () => {
        events.push('active-run-check')
        return activeRun
          ? {
              channelId,
              id: runId,
              status: 'running',
            }
          : null
      },
    },
    toolRegistryEntry: {
      findFirst: async () => ({
        ...builtinState,
        toolId: DEEP_WATER_RUN_UPDATE_TOOL_ID,
      }),
      findMany: async () => {
        events.push('projection-read')
        return liveEntries
      },
      upsert: async () => ({}),
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
  } as unknown as PrismaClient
  return {
    events,
    get policy() {
      return policy
    },
    prisma,
    setBuiltinEnabled(enabled: boolean) {
      builtinState.enabled = enabled
    },
    get updateCalls() {
      return updateCalls
    },
  }
}

test('bundle grant locks team before final projection read and agent policy', async () => {
  const state = buildAccessPrisma(false)
  await setDeepWaterAgentAccess(state.prisma, {
    agentId,
    enabled: true,
    organizationId,
    teamId,
  })

  assert.equal(state.events[0], 'team-lock')
  assert.ok(
    state.events.indexOf('projection-read') < state.events.indexOf('agent-lock'),
  )
  assert.equal(state.updateCalls, 1)
  for (const entry of liveEntries) assert.equal(state.policy[entry.id], true)
})

test('bundle revoke blocks while a linked run is nonterminal', async () => {
  const state = buildAccessPrisma(true)

  await assert.rejects(
    () =>
      setDeepWaterAgentAccess(state.prisma, {
        agentId,
        enabled: false,
        organizationId,
        teamId,
      }),
    (error: unknown) =>
      error instanceof DeepWaterAgentAccessError
      && error.code === DEEP_WATER_AGENT_ACCESS_ERROR_CODES.ACTIVE_RUNS
      && error.message.includes(`/channels/${channelId}`),
  )
  assert.equal(state.events[0], 'team-lock')
  assert.ok(
    state.events.indexOf('agent-lock')
      < state.events.indexOf('active-run-check'),
  )
  assert.equal(state.updateCalls, 0)
  assert.equal(state.policy[liveEntries[0]!.id], true)
})

test('bundle revoke clears a disabled updater before it can be re-enabled', async () => {
  const state = buildAccessPrisma(false, {
    enabled: false,
    status: 'active',
  })

  await setDeepWaterAgentAccess(state.prisma, {
    agentId,
    enabled: false,
    organizationId,
    teamId,
  })

  for (const entry of liveEntries) {
    assert.notEqual(state.policy[entry.id], true)
  }
  assert.notEqual(state.policy[DEEP_WATER_RUN_UPDATE_TOOL_ID], true)
  assert.notEqual(state.policy[deepWaterBundleMarkerKey(teamId)], true)

  state.setBuiltinEnabled(true)
  assert.notEqual(state.policy[DEEP_WATER_RUN_UPDATE_TOOL_ID], true)
})
