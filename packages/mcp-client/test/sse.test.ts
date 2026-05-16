import assert from 'node:assert/strict'
import test from 'node:test'

import { McpClientManager } from '../src/index.js'
import { startSseFake } from './fake-server.js'

test('sse: open → listTools → callTool → close', async () => {
  const fake = await startSseFake()
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'sse', url: fake.url })
    const tools = await mgr.listTools(id)
    assert.ok(tools.find((t) => t.name === 'echo'))
    const echoed = await mgr.callTool(id, 'echo', { message: 'sse-hello' })
    assert.deepEqual(echoed.content, [{ type: 'text', text: 'sse-hello' }])
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('sse: reconnect after transport drop invalidates discovery cache', async () => {
  const fake = await startSseFake()
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'sse', url: fake.url })
    const before = await mgr.listTools(id)
    fake.dropConnections()
    const reconnected = await mgr.reconnect(id)
    assert.equal(reconnected, true)
    const after = await mgr.listTools(id)
    // Reference inequality proves reconnect invalidated the cache and the next
    // listTools issued a fresh tools/list against the new connection.
    assert.notStrictEqual(after, before)
    assert.ok(after.find((t) => t.name === 'add'))
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})
