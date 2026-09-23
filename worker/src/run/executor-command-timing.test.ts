import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  EXECUTOR_MCP_CALL_TIMEOUT_MS,
  EXECUTOR_MCP_COMMAND_TTL_MS,
  EXECUTOR_MCP_START_TIMEOUT_MS,
  EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
} from '@nessie/schemas'

import {
  executorCommandTtlMs,
  executorToolTimeoutMs,
  ExecutorUnknownOutcomeError,
} from './executor-command-timing.js'
import { buildExecutorToolset } from './executor-toolset.js'
import { isFatalToolExecutionError } from './tool-execution-errors.js'

test('a local program gets the shared mcp TTL, not the 25-second file-operation one', () => {
  // The TTL used to be 25 s for every mcp command, shorter than the daemon's
  // own start plus call timeouts: a slow navigation expired mid-call and the
  // unknown outcome aborted the run.
  assert.equal(executorCommandTtlMs('mcp.tools'), EXECUTOR_MCP_COMMAND_TTL_MS)
  assert.equal(executorCommandTtlMs('mcp.call'), EXECUTOR_MCP_COMMAND_TTL_MS)
  assert.ok(
    executorCommandTtlMs('mcp.call') > EXECUTOR_MCP_START_TIMEOUT_MS + EXECUTOR_MCP_CALL_TIMEOUT_MS,
    'a cold start followed by a full-length call fits inside the command',
  )
})

test('every other operation keeps the TTL it had', () => {
  assert.equal(executorCommandTtlMs('file.read'), 25_000)
  assert.equal(executorCommandTtlMs('sandbox.stop'), 25_000)
  assert.equal(executorCommandTtlMs('browser.open'), 180_000)
  assert.equal(executorCommandTtlMs('coding.launch'), 180_000)
  assert.equal(executorCommandTtlMs('command.run'), 360_000)
})

test('the tool timeout sits a margin past the TTL, so the TTL fires first', () => {
  for (const operationKey of ['mcp.call', 'file.read', 'browser.act', 'command.run']) {
    assert.equal(
      executorToolTimeoutMs(operationKey),
      executorCommandTtlMs(operationKey) + EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
    )
  }
})

test('an unknown outcome aborts the run instead of becoming a retriable failure', () => {
  assert.equal(isFatalToolExecutionError(new ExecutorUnknownOutcomeError()), true)
  assert.equal(isFatalToolExecutionError(new ExecutorUnknownOutcomeError('tool-call-1')), true)
  assert.equal(new ExecutorUnknownOutcomeError('tool-call-1').toolCallRecordId, 'tool-call-1')
})

test('the toolset times its own tools by their command and answers nothing for other names', async () => {
  const capabilityRevision = { descriptor: { mcpServers: ['kelpie'] } }
  const prisma = {
    executorBinding: {
      findMany: async () => [
        // The mcp pair is offered only on a revision that names a program.
        { capabilityRevision, id: '00000000-0000-4000-8000-000000000004', operationKey: 'mcp.tools', session: null },
        { capabilityRevision, id: '00000000-0000-4000-8000-000000000005', operationKey: 'mcp.call', session: null },
      ],
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  } as unknown as PrismaClient

  const toolset = await buildExecutorToolset(prisma, {
    agentId: '00000000-0000-4000-8000-000000000002',
    agentToolPolicy: { 'executor.mcp.call': true, 'executor.mcp.tools': true },
    encryptionSecret: 'test-secret',
    hostOutput: null,
    organizationId: '00000000-0000-4000-8000-000000000001',
    runId: '00000000-0000-4000-8000-000000000003',
  })

  assert.deepEqual([...toolset.handledNames].sort(), ['executor_mcp_call', 'executor_mcp_tools'])
  assert.equal(toolset.timeoutMsFor('executor_mcp_call'), EXECUTOR_MCP_COMMAND_TTL_MS + EXECUTOR_TOOL_TIMEOUT_MARGIN_MS)
  assert.equal(toolset.timeoutMsFor('executor_mcp_tools'), EXECUTOR_MCP_COMMAND_TTL_MS + EXECUTOR_TOOL_TIMEOUT_MARGIN_MS)
  assert.equal(toolset.timeoutMsFor('kb_search'), undefined)
  // A bound tool that is not offered to this run is not this toolset's either.
  assert.equal(toolset.timeoutMsFor('executor_file_read'), undefined)

  const error = toolset.timeoutErrorFor('executor_mcp_call')
  assert.ok(error instanceof ExecutorUnknownOutcomeError)
  assert.equal(isFatalToolExecutionError(error), true)
  assert.equal(toolset.timeoutErrorFor('kb_search'), null)
})

test('a run with no executor transport times nothing as an executor tool', async () => {
  const toolset = await buildExecutorToolset({} as PrismaClient, {
    agentId: '00000000-0000-4000-8000-000000000002',
    agentToolPolicy: null,
    encryptionSecret: undefined,
    hostOutput: null,
    organizationId: '00000000-0000-4000-8000-000000000001',
    runId: '00000000-0000-4000-8000-000000000003',
  })
  assert.equal(toolset.timeoutMsFor('executor_mcp_call'), undefined)
  assert.equal(toolset.timeoutErrorFor('executor_mcp_call'), null)
})
