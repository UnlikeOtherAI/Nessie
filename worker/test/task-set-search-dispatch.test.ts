import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { executeExecutorMcpCommand } from '../../executor/src/mcp-dispatch.js'
import { createExecutorMcpSessionManager } from '../../executor/src/mcp-session-manager.js'
import type { ExecutorLocalMcpServer } from '../../executor/src/mcp-servers.js'
import { presentExecutorResultForModel } from '../src/run/executor-result-presentation.js'
import { executorDispatchResult } from '../src/run/executor-toolset.js'
import { taskSetSearchDescriptors, taskSetSearchFailure } from '../src/task-sets/search.js'

/**
 * Task Set search reads the executor toolset's `dispatch` output itself: the
 * `ollama-search` catalog to build its two tools, and each call's failure code
 * for its remedy states. The agent loop shapes executor results for the model
 * after dispatch; if that shaping ever moved into dispatch, every research
 * step would fail to parse and block as setup required — which no test
 * noticed the last time it was proposed.
 *
 * So this drives a real MCP server subprocess through the daemon's own
 * operation (`executeExecutorMcpCommand` and the session manager), shapes each
 * terminal document with the function `dispatch` itself answers with, and
 * hands the result to search's own parsers. The control-plane hop in between
 * (encrypt, deliver, receipt, decrypt) is JSON in and the same JSON out.
 */

const SCRIPT = fileURLToPath(new URL('../../executor/test/fixtures/scripted-mcp-server.mjs', import.meta.url))

const ollamaSearch: ExecutorLocalMcpServer = {
  command: [process.execPath, SCRIPT],
  env: { NESSIE_TEST_MCP_MODE: 'ollama-search' },
  name: 'ollama-search',
}

const withSessions = async (run: (dispatch: (operationKey: 'mcp.tools' | 'mcp.call', args: unknown) => Promise<ReturnType<typeof executorDispatchResult>>) => Promise<void>) => {
  const sessions = createExecutorMcpSessionManager([ollamaSearch], { maxResultBytes: 65_536 }, {
    log: () => undefined,
    startTimeoutMs: 15_000,
  })
  try {
    await run(async (operationKey, args) => executorDispatchResult(
      await executeExecutorMcpCommand(operationKey, args, sessions),
    ))
  } finally {
    await sessions.stopAll()
  }
}

test('search builds its two tools from the raw catalog a real server lists', async () => {
  await withSessions(async (dispatch) => {
    const listed = await dispatch('mcp.tools', { server: 'ollama-search' })
    assert.equal(listed.success, true)
    const descriptors = taskSetSearchDescriptors(listed.output)
    assert.deepEqual(descriptors.map((descriptor) => descriptor.toolName), ['ollama_web_search', 'ollama_web_fetch'])
    assert.deepEqual(
      (descriptors[0]!.inputSchema as { required: string[] }).required,
      ['query'],
      'the program’s own schema reaches the processor verbatim',
    )
  })
})

test('a research call answers the raw document, and a program failure keeps its reason code', async () => {
  await withSessions(async (dispatch) => {
    const found = await dispatch('mcp.call', {
      arguments: { max_results: 2, query: 'executor timing' },
      server: 'ollama-search',
      tool: 'ollama_web_search',
    })
    assert.equal(found.success, true)
    const document = JSON.parse(found.output) as { content: Array<{ text: string; type: string }> }
    const results = JSON.parse(document.content[0]!.text) as { results: Array<{ url: string }> }
    assert.equal(results.results[0]?.url, 'https://example.com/')

    const quota = await dispatch('mcp.call', {
      arguments: { query: 'quota' },
      server: 'ollama-search',
      tool: 'ollama_web_search',
    })
    assert.equal(quota.success, false)
    assert.equal(taskSetSearchFailure(quota.output), 'search_quota_exhausted')
  })
})

test('the model-facing presentation is not something search could parse', async () => {
  // The reason presentation lives on the agent loop's path and not in
  // dispatch: the same catalog, shaped for a model, is prose.
  await withSessions(async (dispatch) => {
    const quota = await dispatch('mcp.call', {
      arguments: { query: 'quota' },
      server: 'ollama-search',
      tool: 'ollama_web_search',
    })
    const presented = presentExecutorResultForModel('mcp.call', { server: 'ollama-search' }, { inputSummary: '', ...quota })
    assert.equal(taskSetSearchFailure(presented.output), 'processor_search_unavailable')
    assert.throws(() => JSON.parse(presented.output))
  })
})
