import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { McpClientManager, McpNotConnectedError, McpTimeoutError } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const STDIO_SERVER = join(HERE, 'stdio-fake-server.ts')

const STDIO_BASE = {
  transport: 'stdio' as const,
  command: process.execPath,
  args: ['--import', 'tsx', STDIO_SERVER],
  env: { ...process.env } as Record<string, string>,
}

test('stdio: open → listTools → callTool → close', async () => {
  const mgr = new McpClientManager()
  const id = await mgr.open(STDIO_BASE)
  try {
    const tools = await mgr.listTools(id)
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['add', 'echo'])
    const echoed = await mgr.callTool(id, 'echo', { message: 'hi' })
    assert.equal(echoed.isError, false)
    assert.deepEqual(echoed.content, [{ type: 'text', text: 'hi' }])
  } finally {
    await mgr.close(id)
  }
})

test('stdio: callTool after close raises NOT_CONNECTED', async () => {
  const mgr = new McpClientManager()
  const id = await mgr.open(STDIO_BASE)
  await mgr.close(id)
  await assert.rejects(
    () => mgr.callTool(id, 'echo', { message: 'x' }),
    (err: unknown) => err instanceof McpNotConnectedError && err.kind === 'NOT_CONNECTED',
  )
})

test('stdio: timeoutMs triggers TIMEOUT error', async () => {
  const mgr = new McpClientManager()
  const id = await mgr.open({
    ...STDIO_BASE,
    env: { ...STDIO_BASE.env, NESSIE_FAKE_ECHO_DELAY_MS: '500' },
  })
  try {
    await assert.rejects(
      () => mgr.callTool(id, 'echo', { message: 'slow' }, { timeoutMs: 50 }),
      (err: unknown) => err instanceof McpTimeoutError && err.kind === 'TIMEOUT',
    )
  } finally {
    await mgr.close(id)
  }
})
