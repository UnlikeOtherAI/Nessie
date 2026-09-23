import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExecutorMcpTool } from '@nessie/schemas'

import { createExecutorMcpCatalogs } from './executor-mcp-catalog.js'
import type { AgenticToolResult } from './tools.js'

const DIGEST = `sha256:${'a'.repeat(64)}`

const tool = (name: string, properties: Record<string, unknown> = {}): ExecutorMcpTool => ({
  description: `${name}.`,
  inputSchema: { properties, type: 'object' },
  name,
})

const page = (
  tools: ExecutorMcpTool[],
  options: { digest?: string; nextCursor?: string; recordId: string; server?: string },
): AgenticToolResult => ({
  inputSummary: '{}',
  output: JSON.stringify({
    catalog: {
      digest: options.digest ?? DIGEST,
      server: options.server ?? 'kelpie',
      tools,
      ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
    },
    success: true,
  }),
  success: true,
  toolCallRecordId: options.recordId,
})

const harness = (pages: AgenticToolResult[], mcpServers: readonly string[] = ['kelpie']) => {
  const requests: Array<{ args: { cursor?: string; server: string }; providerToolCallId: string }> = []
  const ended: string[] = []
  const catalogs = createExecutorMcpCatalogs({
    endPage: async (toolCallRecordId) => {
      ended.push(toolCallRecordId)
    },
    listPage: async (args, providerToolCallId) => {
      requests.push({ args, providerToolCallId })
      const next = pages.shift()
      assert.ok(next, 'no more pages scripted')
      return next
    },
    mcpServers: () => mcpServers,
  })
  return { catalogs, ended, requests }
}

test('the whole catalog is walked once per program per run and then answered from memory', async () => {
  const { catalogs, ended, requests } = harness([
    page([tool('navigate'), tool('click')], { nextCursor: '2', recordId: 'record-1' }),
    page([tool('screenshot')], { recordId: 'record-2' }),
  ])

  const first = await catalogs.load('kelpie', 'call-1')
  assert.ok(!('failure' in first))
  assert.deepEqual(first.tools.map((entry) => entry.name), ['navigate', 'click', 'screenshot'])
  // The model's call ends the first page's record; the walk ends the rest.
  assert.equal(first.toolCallRecordId, 'record-1')
  assert.deepEqual(ended, ['record-2'])
  assert.deepEqual(requests, [
    { args: { server: 'kelpie' }, providerToolCallId: 'call-1' },
    { args: { cursor: '2', server: 'kelpie' }, providerToolCallId: 'call-1:page-2' },
  ])

  const second = await catalogs.load('kelpie', 'call-2')
  assert.ok(!('failure' in second))
  assert.equal(second.tools.length, 3)
  assert.equal(second.toolCallRecordId, undefined)
  assert.equal(requests.length, 2, 'no second trip to the machine')
})

test('a tool’s input schema is known only after the run has listed its program', async () => {
  const { catalogs } = harness([page([tool('navigate', { timeoutMs: { type: 'integer' } })], { recordId: 'record-1' })])
  assert.equal(catalogs.inputSchemaOf('kelpie', 'navigate'), undefined)
  await catalogs.load('kelpie', 'call-1')
  assert.deepEqual(catalogs.inputSchemaOf('kelpie', 'navigate'), {
    properties: { timeoutMs: { type: 'integer' } },
    type: 'object',
  })
  assert.equal(catalogs.inputSchemaOf('kelpie', 'missing'), undefined)
  assert.equal(catalogs.inputSchemaOf('ollama-search', 'navigate'), undefined)
})

test('a program the reviewed policy does not name is refused before anything is sent', async () => {
  const { catalogs, requests } = harness([], ['kelpie', 'ollama-search'])
  const answer = await catalogs.load('photoshop', 'call-1')
  assert.ok('failure' in answer)
  assert.equal(answer.failure.correctable, true)
  assert.match(answer.failure.output, /Its programs: kelpie, ollama-search\./)
  assert.equal(requests.length, 0)
})

test('a failed page is the answer, and nothing is cached from it', async () => {
  const refused: AgenticToolResult = {
    inputSummary: '{}',
    output: JSON.stringify({ code: 'EXECUTOR_MCP_UNAVAILABLE', message: 'not installed', success: false }),
    success: false,
    toolCallRecordId: 'record-1',
  }
  const { catalogs, requests } = harness([refused, page([tool('navigate')], { recordId: 'record-2' })])
  const answer = await catalogs.load('kelpie', 'call-1')
  assert.ok('failure' in answer)
  assert.equal(answer.failure.output, refused.output)
  assert.equal(answer.failure.toolCallRecordId, 'record-1')
  const retried = await catalogs.load('kelpie', 'call-2')
  assert.ok(!('failure' in retried))
  assert.equal(requests.length, 2)
})

test('a later page that fails still hands back the first page’s record', async () => {
  const { catalogs, ended } = harness([
    page([tool('navigate')], { nextCursor: '1', recordId: 'record-1' }),
    { inputSummary: '{}', output: '{"code":"EXECUTOR_MCP_CURSOR_INVALID","success":false}', success: false, toolCallRecordId: 'record-2' },
  ])
  const answer = await catalogs.load('kelpie', 'call-1')
  assert.ok('failure' in answer)
  assert.equal(answer.failure.toolCallRecordId, 'record-1')
  assert.deepEqual(ended, ['record-2'])
})

test('a catalog that changes between pages is refused rather than stitched together', async () => {
  const { catalogs } = harness([
    page([tool('navigate')], { nextCursor: '1', recordId: 'record-1' }),
    page([tool('click')], { digest: `sha256:${'b'.repeat(64)}`, recordId: 'record-2' }),
  ])
  const answer = await catalogs.load('kelpie', 'call-1')
  assert.ok('failure' in answer)
  assert.match(answer.failure.output, /changed its tools while they were being listed/)
  assert.equal(catalogs.inputSchemaOf('kelpie', 'navigate'), undefined)
})

test('an answer that is not a catalog of that program is refused', async () => {
  const { catalogs } = harness([page([tool('navigate')], { recordId: 'record-1', server: 'other' })])
  const answer = await catalogs.load('kelpie', 'call-1')
  assert.ok('failure' in answer)
  assert.match(answer.failure.output, /a catalog this run cannot read/)
})
