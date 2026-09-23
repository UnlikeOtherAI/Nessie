import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { isCorrectableExecutorFailure } from './executor-correctable-failures.js'
import { buildExecutorToolset } from './executor-toolset.js'

const refused = (text: string) => ({
  code: 'EXECUTOR_MCP_CALL_FAILED',
  content: [{ text, type: 'text' }],
  isError: true,
  success: false,
})

test('the daemon refusals the model fixes by changing its call are correctable', () => {
  for (const code of [
    'EXECUTOR_COMMAND_ARGUMENTS_INVALID',
    'EXECUTOR_MCP_RESULT_TOO_LARGE',
    'EXECUTOR_MCP_CURSOR_INVALID',
  ]) {
    assert.equal(isCorrectableExecutorFailure({ code, success: false }), true, code)
  }
})

test('a server refusing an unknown tool or its arguments is correctable', () => {
  // The exact texts an MCP SDK server answers before its tool runs.
  assert.equal(isCorrectableExecutorFailure(refused('MCP error -32602: Tool wait_for_elemnt not found')), true)
  assert.equal(
    isCorrectableExecutorFailure(refused(
      'MCP error -32602: Input validation error: Invalid arguments for tool navigate: [{"path":["url"]}]',
    )),
    true,
  )
})

test('the program failing is not correctable, and counts', () => {
  // The tool ran and reported an error: the program, not the call, is what failed.
  assert.equal(isCorrectableExecutorFailure(refused('{"error":"instance not paired"}')), false)
  // Same JSON-RPC code, but the program's own output broke its schema.
  assert.equal(
    isCorrectableExecutorFailure(refused(
      'MCP error -32602: Output validation error: Invalid structured content for tool navigate: x',
    )),
    false,
  )
  assert.equal(isCorrectableExecutorFailure({ code: 'EXECUTOR_MCP_UNAVAILABLE', success: false }), false)
  assert.equal(isCorrectableExecutorFailure({ code: 'EXECUTOR_MCP_CALL_FAILED', success: false }), false)
  // A refusal text without the daemon's failure code is not the server refusing.
  assert.equal(
    isCorrectableExecutorFailure({ ...refused('MCP error -32602: Tool x not found'), code: undefined }),
    false,
  )
})

test('a success is never correctable, whatever it says', () => {
  assert.equal(
    isCorrectableExecutorFailure({ ...refused('MCP error -32602: Tool x not found'), success: true }),
    false,
  )
})

test('a tool name the executor toolset does not offer is a correctable failure', async () => {
  const prisma = {
    executorBinding: { findMany: async () => [] },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient
  const toolset = await buildExecutorToolset(prisma, {
    agentId: '00000000-0000-4000-8000-000000000002',
    agentToolPolicy: {},
    encryptionSecret: 'test-secret',
    hostOutput: null,
    organizationId: '00000000-0000-4000-8000-000000000001',
    runId: '00000000-0000-4000-8000-000000000003',
  })
  const result = await toolset.dispatch('executor_mcp_cal', {}, 'call-1')
  assert.equal(result.success, false)
  assert.equal(result.correctable, true)
})
