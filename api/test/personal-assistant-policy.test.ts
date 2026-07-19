import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
} from '../src/services/agent-tool-policy.js'
import { ensurePersonalAssistantAgent } from '../src/services/personal-assistant.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const projectedId = '00000000-0000-4000-8000-000000000003'
const teamId = '00000000-0000-4000-8000-000000000004'

const currentPolicy = {
  deep_water_run_update: true,
  [projectedId]: true,
  [`__nessie_deep_water_bundle__:${teamId}`]: true,
  ordinary_old: true,
}

const buildPrisma = () => {
  let lockCalls = 0
  let updateCalls = 0
  let updatedPolicy: unknown
  const current = {
    id: agentId,
    model: 'model',
    provider: 'provider',
    role: 'assistant',
    systemPrompt: 'Prompt',
    toolPolicy: currentPolicy,
  }
  const tx = {
    $executeRaw: async () => {
      lockCalls += 1
      return 0
    },
    agent: {
      create: async () => ({ id: agentId }),
      findFirst: async () => ({ id: agentId }),
      findUniqueOrThrow: async () => current,
      update: async ({ data }: { data: { toolPolicy?: unknown } }) => {
        updateCalls += 1
        updatedPolicy = data.toolPolicy
        return { id: agentId }
      },
    },
    toolRegistryEntry: {
      findMany: async () => [{
        id: projectedId,
        metadata: { requiresExplicitGrant: true },
        toolId: 'mcp:deep-water:research_start',
      }],
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
  } as unknown as PrismaClient

  return {
    get lockCalls() {
      return lockCalls
    },
    prisma,
    get updateCalls() {
      return updateCalls
    },
    get updatedPolicy() {
      return updatedPolicy
    },
  }
}

test('bootstrap without config preserves current explicit policy under both locks', async () => {
  const state = buildPrisma()

  await ensurePersonalAssistantAgent(state.prisma, organizationId)

  assert.equal(state.lockCalls, 2)
  assert.equal(state.updateCalls, 1)
  assert.deepEqual(state.updatedPolicy, currentPolicy)
})

test('bootstrap config cannot inject an explicit-grant tool', async () => {
  const state = buildPrisma()

  await assert.rejects(
    () =>
      ensurePersonalAssistantAgent(state.prisma, organizationId, {
        toolPolicy: { deep_water_run_update: true },
      }),
    (error: unknown) =>
      error instanceof AgentToolPolicyError
      && error.code === AGENT_TOOL_POLICY_ERROR_CODES.PROTECTED_INPUT,
  )
  assert.equal(state.updateCalls, 0)
})

test('bootstrap ordinary config preserves existing protected grants only', async () => {
  const state = buildPrisma()

  await ensurePersonalAssistantAgent(state.prisma, organizationId, {
    toolPolicy: { ordinary_new: true },
  })

  assert.deepEqual(state.updatedPolicy, {
    deep_water_run_update: true,
    [projectedId]: true,
    [`__nessie_deep_water_bundle__:${teamId}`]: true,
    ordinary_new: true,
  })
})
