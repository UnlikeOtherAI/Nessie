import assert from 'node:assert/strict'
import test from 'node:test'

import { Backoff } from '../src/backoff.js'
import { DiscoveryCache, normaliseTools } from '../src/discovery.js'
import {
  McpClientManager,
  McpNotConnectedError,
  McpTimeoutError,
  type McpConnectionId,
  type McpManagerEvent,
} from '../src/index.js'
import { McpConnection } from '../src/client.js'
import { startHttpFake } from './fake-server.js'

test('Backoff returns null once budget exhausted', () => {
  // Fixed random=0.5 makes the math deterministic: delay = floor(0.5 * cappedExp).
  const b = new Backoff({ initialMs: 100, maxMs: 400, factor: 2, maxAttempts: 3 }, () => 0.5)
  const delays: (number | null)[] = []
  for (let i = 0; i < 5; i += 1) delays.push(b.nextDelay())
  assert.equal(delays[0], 50) // floor(0.5 * 100)
  assert.equal(delays[1], 100) // floor(0.5 * 200)
  assert.equal(delays[2], 200) // floor(0.5 * min(30000, 400))
  assert.equal(delays[3], null)
  assert.equal(delays[4], null)
})

test('Backoff resets attempt count', () => {
  const b = new Backoff({ initialMs: 10, maxMs: 100, factor: 2, maxAttempts: 2 }, () => 0.5)
  b.nextDelay()
  b.nextDelay()
  assert.equal(b.nextDelay(), null)
  b.reset()
  assert.notEqual(b.nextDelay(), null)
})

test('DiscoveryCache honours TTL and explicit invalidation', () => {
  const cache = new DiscoveryCache(100)
  cache.set('id-1', [{ name: 'echo', inputSchema: { type: 'object' } }], 1_000)
  assert.equal(cache.get('id-1', 1_050)?.length, 1)
  assert.equal(cache.get('id-1', 1_200), null)
  cache.set('id-1', [{ name: 'add', inputSchema: { type: 'object' } }], 2_000)
  cache.invalidate('id-1')
  assert.equal(cache.get('id-1', 2_010), null)
})

test('normaliseTools strips unknown shapes safely', () => {
  const tools = normaliseTools({
    tools: [
      {
        name: 'echo',
        description: 'd',
        title: 't',
        inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        outputSchema: { type: 'object' },
        annotations: { destructiveHint: false },
      },
      // missing optional fields — still parses
      { name: 'bare', inputSchema: { type: 'object' } },
    ],
  })
  assert.equal(tools.length, 2)
  assert.equal(tools[0]?.name, 'echo')
  assert.equal(tools[0]?.title, 't')
  assert.equal(tools[0]?.outputSchema?.type, 'object')
  assert.equal(tools[1]?.title, undefined)
})

test('listTools uses cache; refresh forces a fresh round trip', async () => {
  const fake = await startHttpFake()
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'http', url: fake.url })
    const a = await mgr.listTools(id)
    const b = await mgr.listTools(id)
    // Same array reference if cached
    assert.strictEqual(a, b)
    const c = await mgr.refresh(id)
    assert.notStrictEqual(a, c)
    assert.deepEqual(
      a.map((t) => t.name).sort(),
      c.map((t) => t.name).sort(),
    )
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('callTool honours an external AbortSignal', async () => {
  const fake = await startHttpFake({ echoDelayMs: 500 })
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'http', url: fake.url })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error('user-cancel')), 20)
    await assert.rejects(
      () => mgr.callTool(id, 'echo', { message: 'slow' }, { abort: ctrl.signal, timeoutMs: 5000 }),
      // Aborts arrive classified as TRANSPORT or AUTH-irrelevant; just assert it threw.
      (err: unknown) => err instanceof Error,
    )
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('callTool timeoutMs raises a typed TIMEOUT error', async () => {
  const fake = await startHttpFake({ echoDelayMs: 500 })
  const mgr = new McpClientManager()
  try {
    const id = await mgr.open({ transport: 'http', url: fake.url })
    await assert.rejects(
      () => mgr.callTool(id, 'echo', { message: 'slow' }, { timeoutMs: 10 }),
      (err: unknown) => err instanceof McpTimeoutError && err.kind === 'TIMEOUT',
    )
    await mgr.close(id)
  } finally {
    await fake.close()
  }
})

test('listTools timeoutMs raises a typed TIMEOUT error', async () => {
  const conn = new McpConnection(
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as McpConnectionId,
    { transport: 'http', url: 'http://127.0.0.1/mcp' },
    {
      onState: () => {},
      onError: () => {},
      onNotification: () => {},
    },
  )
  ;(conn as unknown as {
    client: {
      listTools: (
        params?: unknown,
        opts?: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
    }
  }).client = {
    listTools: (_params, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true })
      }),
  }

  await assert.rejects(
    () => conn.listTools(false, { timeoutMs: 10 }),
    (err: unknown) => err instanceof McpTimeoutError && err.kind === 'TIMEOUT',
  )
})

test('operations on unknown connection ids raise NOT_CONNECTED', async () => {
  const mgr = new McpClientManager()
  const ghost = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as McpConnectionId
  await assert.rejects(
    () => mgr.listTools(ghost),
    (err: unknown) => err instanceof McpNotConnectedError && err.kind === 'NOT_CONNECTED',
  )
})

test('on(state) receives lifecycle transitions and unsubscribes cleanly', async () => {
  const fake = await startHttpFake()
  const mgr = new McpClientManager()
  const events: McpManagerEvent[] = []
  const off = mgr.on('state', (e) => events.push(e))
  try {
    const id = await mgr.open({ transport: 'http', url: fake.url })
    await mgr.close(id)
  } finally {
    off()
    await fake.close()
  }
  const states = events.filter((e) => e.type === 'state').map((e) => e.state)
  assert.ok(states.includes('ready'), `expected ready in ${states.join(',')}`)
  assert.ok(states.includes('closed'), `expected closed in ${states.join(',')}`)
})

test('closeAll tears down every open connection', async () => {
  const fake = await startHttpFake()
  const mgr = new McpClientManager()
  try {
    const a = await mgr.open({ transport: 'http', url: fake.url })
    const b = await mgr.open({ transport: 'http', url: fake.url })
    await mgr.closeAll()
    await assert.rejects(() => mgr.listTools(a), (err: unknown) => err instanceof McpNotConnectedError)
    await assert.rejects(() => mgr.listTools(b), (err: unknown) => err instanceof McpNotConnectedError)
  } finally {
    await fake.close()
  }
})
