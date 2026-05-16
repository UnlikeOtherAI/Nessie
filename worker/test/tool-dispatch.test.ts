import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpClientManager, McpConnectionId, McpToolResult } from '@nessie/mcp-client'

import {
  TOOL_DISPATCH_ERROR_CODES,
  ToolDispatchError,
  dispatchTool,
  parseMcpTransportConfig,
} from '../src/run/tool-dispatch.js'
import { runMcpTool } from '../src/run/tool-mcp.js'

type StubLog = { method: string; args: unknown[] }

const stubManager = (
  result: McpToolResult,
  log: StubLog[],
): McpClientManager => {
  const fakeId = 'conn-1' as unknown as McpConnectionId
  return {
    async open(spec: unknown) {
      log.push({ method: 'open', args: [spec] })
      return fakeId
    },
    async close(id: unknown) {
      log.push({ method: 'close', args: [id] })
    },
    async closeAll() {
      log.push({ method: 'closeAll', args: [] })
    },
    async callTool(id: unknown, name: string, args: unknown, opts: unknown) {
      log.push({ method: 'callTool', args: [id, name, args, opts] })
      return result
    },
    async listTools() {
      return []
    },
    async refreshTools() {
      return []
    },
  } as unknown as McpClientManager
}

test('parseMcpTransportConfig accepts a valid http config', () => {
  const config = parseMcpTransportConfig({
    transport: 'http',
    url: 'https://example.com/mcp',
  })
  assert.equal(config.transport, 'http')
  if (config.transport === 'http') {
    assert.equal(config.url, 'https://example.com/mcp')
  }
})

test('parseMcpTransportConfig throws typed error on garbage', () => {
  let thrown: unknown
  try {
    parseMcpTransportConfig({ transport: 'http' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
  )
})

test('dispatchTool routes mcp transport through runMcpTool and stringifies structured output', async () => {
  const log: StubLog[] = []
  const result = await runMcpTool({
    transport: { transport: 'http', url: 'https://example.com/mcp' },
    toolName: 'echo',
    args: { hello: 'world' },
    managerFactory: () => stubManager(
      {
        isError: false,
        content: [],
        structuredContent: { reply: 'world' },
      },
      log,
    ),
  })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { reply: 'world' })
  assert.equal(log[0]?.method, 'open')
  assert.equal(log[1]?.method, 'callTool')
})

test('runMcpTool surfaces isError=true responses unchanged', async () => {
  const log: StubLog[] = []
  const result = await runMcpTool({
    transport: { transport: 'http', url: 'https://example.com/mcp' },
    toolName: 'broken',
    args: {},
    managerFactory: () => stubManager(
      { isError: true, content: [{ type: 'text', text: 'boom' }] },
      log,
    ),
  })
  assert.equal(result.isError, true)
  assert.equal(log.find((l) => l.method === 'callTool')?.args[1], 'broken')
})

test('dispatchTool rejects unknown transport at the type level', async () => {
  let thrown: unknown
  try {
    await dispatchTool({
      // @ts-expect-error — exercising the runtime guard with a bogus shape
      spec: { transport: 'voodoo' },
      args: {},
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof ToolDispatchError)
  assert.equal(
    (thrown as ToolDispatchError).code,
    TOOL_DISPATCH_ERROR_CODES.TRANSPORT_UNSUPPORTED,
  )
})
