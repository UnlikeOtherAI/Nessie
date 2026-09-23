import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from './execute/disclosure-basis.js'
import { launchConversationScope } from './executor-host-output.js'
import { buildExecutorToolset } from './executor-toolset.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const runId = '00000000-0000-4000-8000-000000000003'
const channelId = '00000000-0000-4000-8000-000000000009'

// The command's transaction is where dispatch would create it: stopping there
// shows what the run already holds before anything reached the machine.
const STOPPED = 'stopped before the command was created'

const prismaWith = (bindings: Array<{ id: string; operationKey: string }>, earlierCalls = 0) => {
  const counted: unknown[] = []
  return {
    counted,
    prisma: {
      $transaction: async () => { throw new Error(STOPPED) },
      executorBinding: {
        findMany: async () => bindings.map((binding) => ({
          ...binding, capabilityRevision: { descriptor: { mcpServers: ['kelpie'] } }, session: null,
        })),
      },
      toolCall: {
        count: async (query: unknown) => {
          counted.push(query)
          return earlierCalls
        },
      },
      toolRegistryEntry: {
        deleteMany: async () => ({ count: 0 }),
        upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
          id: where.organizationId_scopeKey_toolId.toolId,
        }),
      },
    } as unknown as PrismaClient,
  }
}

const localApps = [
  { id: '00000000-0000-4000-8000-000000000021', operationKey: 'mcp.tools' },
  { id: '00000000-0000-4000-8000-000000000022', operationKey: 'mcp.call' },
]
const policy = { 'executor.file.read': true, 'executor.mcp.call': true, 'executor.mcp.tools': true }

test('a local program’s answer belongs to the launch conversation before its command is sent', async () => {
  for (const [toolName, args] of [
    ['executor_mcp_call', { server: 'kelpie', tool: 'navigate', arguments: { url: 'https://example.com' } }],
    ['executor_mcp_tools', { server: 'kelpie' }],
  ] as const) {
    const sink = createConsumedSourceSink()
    const { prisma } = prismaWith(localApps)
    const toolset = await buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: policy, encryptionSecret: 'test-secret',
      hostOutput: { launchScope: launchConversationScope(channelId), sink }, organizationId, runId,
    })
    assert.deepEqual(sink.list(), [], 'a fresh run has read nothing yet')
    await assert.rejects(toolset.dispatch(toolName, args, 'call-1'), new RegExp(STOPPED))
    assert.deepEqual(sink.list(), [{ scopeId: channelId, scopeType: 'channel' }], toolName)
  }
})

test('an operation that is not a local program leaves the basis alone', async () => {
  const sink = createConsumedSourceSink()
  const { prisma } = prismaWith([{ id: '00000000-0000-4000-8000-000000000023', operationKey: 'file.read' }])
  const toolset = await buildExecutorToolset(prisma, {
    agentId, agentToolPolicy: policy, encryptionSecret: 'test-secret',
    hostOutput: { launchScope: launchConversationScope(channelId), sink }, organizationId, runId,
  })
  await assert.rejects(toolset.dispatch('executor_file_read', { path: 'workspace/a.txt' }, 'call-1'), new RegExp(STOPPED))
  assert.deepEqual(sink.list(), [])
})

test('a run resumed after its worker died holds the stamp before it calls anything', async () => {
  // Its window replays the program answers the earlier execution received.
  const resumed = createConsumedSourceSink()
  const earlier = prismaWith(localApps, 2)
  await buildExecutorToolset(earlier.prisma, {
    agentId, agentToolPolicy: policy, encryptionSecret: 'test-secret',
    hostOutput: { launchScope: launchConversationScope(channelId), sink: resumed }, organizationId, runId,
  })
  assert.deepEqual(resumed.list(), [{ scopeId: channelId, scopeType: 'channel' }])
  assert.deepEqual(earlier.counted, [{
    where: { executorBindingId: { in: localApps.map((binding) => binding.id) }, runId },
  }])

  const fresh = createConsumedSourceSink()
  await buildExecutorToolset(prismaWith(localApps, 0).prisma, {
    agentId, agentToolPolicy: policy, encryptionSecret: 'test-secret',
    hostOutput: { launchScope: launchConversationScope(channelId), sink: fresh }, organizationId, runId,
  })
  assert.deepEqual(fresh.list(), [])
})

test('a caller that is no launch in a conversation passes no scope and records nothing', async () => {
  // Task Set search: its own `ollama-search` binding, under the set's disclosure.
  const { counted, prisma } = prismaWith(localApps, 3)
  const toolset = await buildExecutorToolset(prisma, {
    agentId, agentToolPolicy: policy, encryptionSecret: 'test-secret', hostOutput: null, organizationId, runId,
  })
  await assert.rejects(toolset.dispatch('executor_mcp_tools', { server: 'kelpie' }, 'call-1'), new RegExp(STOPPED))
  assert.deepEqual(counted, [], 'no question is asked on its behalf')
})
