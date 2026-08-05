import assert from 'node:assert/strict'
import test from 'node:test'

import { McpAuthError, McpClientManager } from '../src/index.js'
import { startHttpFake } from './fake-server.js'

test('http: open → listTools → callTool → close', async () => {
  const fake = await startHttpFake()
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'http', url: fake.url, fetchImpl: globalThis.fetch })
    const tools = await mgr.listTools(id)
    assert.ok(tools.find((t) => t.name === 'echo'))
    const sum = await mgr.callTool(id, 'add', { a: 2, b: 3 })
    assert.deepEqual(sum.content, [{ type: 'text', text: '5' }])
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('http: reconnect after transport drop invalidates discovery cache', async () => {
  const fake = await startHttpFake()
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'http', url: fake.url, fetchImpl: globalThis.fetch })
    const before = await mgr.listTools(id)

    fake.dropConnections()

    const reconnected = await mgr.reconnect(id)
    assert.equal(reconnected, true)
    const after = await mgr.listTools(id)
    // Reference inequality proves the post-reconnect listTools issued a fresh
    // tools/list round-trip instead of returning the cached pre-reconnect array.
    assert.notStrictEqual(after, before)
    assert.ok(after.find((t) => t.name === 'add'))
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('http: 401 surfaces as AUTH error', async () => {
  const fake = await startHttpFake({ requireBearer: 'sekret' })
  const mgr = new McpClientManager()
  try {
    await assert.rejects(
      () => mgr.open({ transport: 'http', url: fake.url, fetchImpl: globalThis.fetch }),
      (err: unknown) => err instanceof McpAuthError && err.kind === 'AUTH',
    )

    // Same server, correct header — should succeed.
    const id = await mgr.open({
      transport: 'http',
      url: fake.url,
      headers: { authorization: 'Bearer sekret' },
      fetchImpl: globalThis.fetch,
    })
    const tools = await mgr.listTools(id)
    assert.ok(tools.length > 0)
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('the transport refuses a private address when no fetch override is given', async () => {
  // Production callers get the SSRF-safe, IP-pinned fetch by default. The tests
  // above opt out explicitly because their fixture is on loopback; without that
  // opt-out the guard must block it, which is what keeps a connector URL from
  // reaching internal infrastructure.
  const fake = await startHttpFake()
  const mgr = new McpClientManager()
  try {
    await assert.rejects(
      () => mgr.open({ transport: 'http', url: fake.url }),
      /private or local network/i,
    )
  } finally {
    await fake.close()
  }
})
