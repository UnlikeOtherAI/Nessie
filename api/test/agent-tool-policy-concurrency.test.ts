import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { updateAgentRecord } from '../src/services/agents.js'
import { setAgentToolPolicyForRegistryEntry } from '../src/services/agent-tool-policy-registry.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const explicitToolId = '00000000-0000-4000-8000-000000000003'

test('targeted grant and stale generic PUT serialize without losing either change', async () => {
  let agent = {
    agentKind: 'shared' as const,
    avatarAttachmentId: null,
    bindings: [] as Array<{ channelId: string }>,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    delegationMode: 'none' as const,
    id: agentId,
    messages: [] as Array<{ createdAt: Date }>,
    model: 'gpt-5',
    name: 'Researcher',
    organizationId,
    parentAgentId: null,
    provider: 'openai',
    role: 'assistant',
    runs: [],
    status: 'idle' as const,
    surfacePolicy: 'shared' as const,
    systemManaged: false,
    systemPrompt: null,
    toolPolicy: {} as Record<string, boolean>,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  let locked = false
  const lockWaiters: Array<() => void> = []
  let releaseFirstRead!: () => void
  const firstReadGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve
  })
  let signalFirstRead!: () => void
  const firstReadEntered = new Promise<void>((resolve) => {
    signalFirstRead = resolve
  })
  let readCalls = 0
  let updateCalls = 0
  const registryEntry = {
    description: 'Starts a managed research job.',
    handlerKind: 'mcp',
    id: explicitToolId,
    inputSchema: { type: 'object' },
    mcpInstance: null,
    metadata: { requiresExplicitGrant: true },
    organizationId: null,
    outputSchema: null,
    toolId: 'mcp:deep-water:research_start',
    transportConfig: { toolName: 'research_start' },
  }

  const acquire = async () => {
    if (locked) {
      await new Promise<void>((resolve) => lockWaiters.push(resolve))
    }
    locked = true
  }
  const release = () => {
    const next = lockWaiters.shift()
    if (next) next()
    else locked = false
  }
  const makeTx = () => ({
    $executeRaw: async () => {
      await acquire()
      return 0
    },
    agent: {
      findFirst: async () => {
        readCalls += 1
        if (readCalls === 1) {
          signalFirstRead()
          await firstReadGate
        }
        return agent
      },
      update: async ({ data }: {
        data: Partial<typeof agent>
      }) => {
        updateCalls += 1
        agent = { ...agent, ...data, updatedAt: new Date() }
        return agent
      },
    },
    toolRegistryEntry: {
      findFirst: async () => registryEntry,
      findMany: async ({ where }: {
        where: { id: { in: string[] } }
      }) =>
        where.id.in.includes(explicitToolId)
          ? [registryEntry]
          : [],
    },
    toolGrant: {
      updateMany: async () => ({ count: 1 }),
    },
  })
  const prisma = {
    $transaction: async <T>(
      action: (tx: ReturnType<typeof makeTx>) => Promise<T>,
    ) => {
      const tx = makeTx()
      try {
        return await action(tx)
      } finally {
        release()
      }
    },
    toolRegistryEntry: {
      findFirst: async () => registryEntry,
    },
  } as unknown as PrismaClient

  const targetedGrant = setAgentToolPolicyForRegistryEntry(prisma, {
    agentId,
    enabled: true,
    organizationId,
    toolRegistryEntryId: explicitToolId,
  })
  await firstReadEntered
  const staleGenericPut = updateAgentRecord(prisma, agentId, {
    organizationId,
    toolPolicy: { web_search: false },
  })
  await Promise.resolve()
  assert.equal(updateCalls, 0)

  releaseFirstRead()
  await Promise.all([targetedGrant, staleGenericPut])

  assert.equal(updateCalls, 2)
  assert.deepEqual(agent.toolPolicy, {
    [explicitToolId]: true,
    web_search: false,
  })
})
