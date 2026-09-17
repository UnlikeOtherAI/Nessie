import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { createExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import type { ExecutorLocalMcpServer } from '../src/mcp-servers.js'

/**
 * Every assertion here drives a real child process speaking real MCP over
 * stdio. The framing, the handshake and the teardown are the parts most likely
 * to be wrong, and a stubbed client would prove none of them.
 *
 * One upstream behaviour is pinned below rather than worked around: on
 * @modelcontextprotocol/sdk 1.29, a `StdioClientTransport` whose spawn fails
 * with ENOENT leaves the parent's stdin (fd 0) referenced, so a process that
 * probes a server which is not installed never exits on its own. The daemon
 * survives that — it holds the event loop open for its own reasons — but a
 * test runner does not, which is why this file runs with `--test-force-exit`.
 * The test that pins it will start failing when the SDK fixes it, which is the
 * signal to drop the flag.
 */

const SCRIPT = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))

const serverNamed = (
  name: string,
  mode: string,
): ExecutorLocalMcpServer => ({
  command: [process.execPath, SCRIPT],
  env: { NESSIE_TEST_MCP_MODE: mode },
  name,
})

const managerFor = (servers: ExecutorLocalMcpServer[], maxResultBytes = 65_536) =>
  createExecutorMcpSessionManager(servers, { maxResultBytes }, {
    log: () => undefined,
    startTimeoutMs: 15_000,
  })

test('lists a real server’s catalog and digests it', async () => {
  const sessions = managerFor([serverNamed('scripted', 'ok')])
  try {
    const result = await sessions.listTools('scripted') as {
      catalog: { digest: string; serverVersion?: string; tools: { name: string }[] }
      success: boolean
    }
    assert.equal(result.success, true)
    assert.deepEqual(result.catalog.tools.map((tool) => tool.name), ['echo', 'boom'])
    assert.equal(result.catalog.serverVersion, '9.9.9')
    assert.match(result.catalog.digest, /^sha256:[0-9a-f]{64}$/)
  } finally {
    await sessions.stopAll()
  }
})

test('passes tool arguments through untouched', async () => {
  const sessions = managerFor([serverNamed('scripted', 'ok')])
  try {
    const result = await sessions.callTool('scripted', 'echo', {
      // A field no schema in this repo knows about: the server's grammar is
      // the server's, and the daemon must not filter it.
      unknownToNessie: { nested: [1, 2, 3] },
      value: 'hello',
    }) as { content: { text: string }[]; success: boolean }
    assert.equal(result.success, true)
    const echoed = JSON.parse(result.content[0]!.text) as {
      echoed: { unknownToNessie: unknown; value: string }
    }
    assert.equal(echoed.echoed.value, 'hello')
    assert.deepEqual(echoed.echoed.unknownToNessie, { nested: [1, 2, 3] })
  } finally {
    await sessions.stopAll()
  }
})

test('a server the policy never named is refused without starting anything', async () => {
  const sessions = managerFor([serverNamed('scripted', 'ok')])
  try {
    const result = await sessions.callTool('not-named', 'echo') as { code: string; success: boolean }
    assert.equal(result.success, false)
    assert.equal(result.code, 'EXECUTOR_MCP_DENIED')
  } finally {
    await sessions.stopAll()
  }
})

test('an executor that names no server refuses and says so', async () => {
  const sessions = managerFor([])
  const result = await sessions.listTools('kelpie') as { code: string; message: string }
  assert.equal(result.code, 'EXECUTOR_MCP_DENIED')
  assert.match(result.message, /names none/)
})

test('a tool that answers with isError is reported as a failure, not a success', async () => {
  const sessions = managerFor([serverNamed('scripted', 'ok')])
  try {
    const result = await sessions.callTool('scripted', 'boom') as { code: string; success: boolean }
    assert.equal(result.success, false)
    assert.equal(result.code, 'EXECUTOR_MCP_CALL_FAILED')
  } finally {
    await sessions.stopAll()
  }
})

test('a server that dies mid-call is noticed rather than hanging', async () => {
  const sessions = managerFor([serverNamed('scripted', 'die-on-call')])
  try {
    const result = await sessions.callTool('scripted', 'echo', { value: 'x' }) as {
      code: string
      success: boolean
    }
    assert.equal(result.success, false)
    assert.equal(result.code, 'EXECUTOR_MCP_UNAVAILABLE')
  } finally {
    await sessions.stopAll()
  }
})

test('a result over the budget is refused rather than truncated', async () => {
  const sessions = managerFor([serverNamed('scripted', 'huge')], 4_096)
  try {
    const result = await sessions.callTool('scripted', 'echo') as {
      code: string
      maxResultBytes: number
      success: boolean
    }
    assert.equal(result.success, false)
    assert.equal(result.code, 'EXECUTOR_MCP_RESULT_TOO_LARGE')
    assert.equal(result.maxResultBytes, 4_096)
  } finally {
    await sessions.stopAll()
  }
})

test('a catalog larger than one result pages, and the digest is stable across pages', async () => {
  const sessions = managerFor([serverNamed('scripted', 'many-tools')], 8_192)
  try {
    const first = await sessions.listTools('scripted') as {
      catalog: { digest: string; nextCursor?: string; tools: { name: string }[] }
    }
    assert.ok(first.catalog.nextCursor, 'a 40-tool catalog must not fit one 8 KiB result')
    const second = await sessions.listTools('scripted', first.catalog.nextCursor) as {
      catalog: { digest: string; tools: { name: string }[] }
    }
    assert.equal(second.catalog.digest, first.catalog.digest)
    assert.notEqual(second.catalog.tools[0]!.name, first.catalog.tools[0]!.name)
  } finally {
    await sessions.stopAll()
  }
})

test('probe distinguishes a missing program from one that dies on start', async () => {
  const missing = managerFor([{ command: ['/nonexistent/kelpie', 'mcp'], name: 'kelpie' }])
  const dying = managerFor([serverNamed('kelpie', 'never-start')])
  try {
    const notInstalled = await missing.probe('kelpie')
    assert.equal(notInstalled.available, false)
    assert.equal(
      notInstalled.available === false ? notInstalled.reason : undefined,
      'not_installed',
      'a program that is not on disk is not installed, not a handshake failure',
    )
    const launchFailed = await dying.probe('kelpie')
    assert.equal(launchFailed.available, false)
    assert.equal(
      launchFailed.available === false ? launchFailed.reason : undefined,
      'launch_failed',
    )
  } finally {
    await missing.stopAll()
    await dying.stopAll()
  }
})

test('probe of an unnamed server is not_probed, never a failure of the server', async () => {
  const sessions = managerFor([])
  const outcome = await sessions.probe('kelpie')
  assert.equal(outcome.available, false)
  assert.equal(outcome.available === false ? outcome.reason : undefined, 'not_probed')
})

test('a failure message never carries the launch spec', async () => {
  // The host path is the thing that must not travel; it is in the argv and in
  // the underlying spawn error, so a message built from either would leak it.
  const secret = '/Users/someone/private/kelpie-build/kelpie'
  const sessions = managerFor([{ command: [secret, 'mcp'], name: 'kelpie' }])
  try {
    const result = await sessions.listTools('kelpie') as { message: string }
    assert.ok(!result.message.includes(secret), `leaked the launch spec: ${result.message}`)
    assert.ok(!result.message.includes('/Users/'), `leaked a host path: ${result.message}`)
    assert.match(result.message, /"kelpie"/)
  } finally {
    await sessions.stopAll()
  }
})

test('concurrent calls to one server serialize instead of interleaving on the stdio stream', async () => {
  const sessions = managerFor([serverNamed('scripted', 'ok')])
  try {
    const answers = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        sessions.callTool('scripted', 'echo', { value: `call-${index}` })),
    )
    // Every answer must be the answer to its own request. Interleaved writes
    // on one duplex would cross them, which is what the session queue prevents.
    answers.forEach((answer, index) => {
      const content = (answer as { content: { text: string }[] }).content
      const echoed = JSON.parse(content[0]!.text) as { echoed: { value: string } }
      assert.equal(echoed.echoed.value, `call-${index}`)
    })
  } finally {
    await sessions.stopAll()
  }
})

test('PINNED UPSTREAM: a failed spawn leaves the SDK holding stdin', async () => {
  // Not our leak and not a rule we want — it is the reason this file needs
  // `--test-force-exit`. When this assertion fails, @modelcontextprotocol/sdk
  // has fixed it and the flag can go.
  const sessions = managerFor([{ command: ['/nonexistent/kelpie', 'mcp'], name: 'kelpie' }])
  await sessions.probe('kelpie')
  await sessions.stopAll()
  await new Promise((resolve) => { setTimeout(resolve, 250) })
  const handles = (process as unknown as {
    _getActiveHandles: () => { constructor: { name: string }; fd?: number }[]
  })._getActiveHandles()
  assert.ok(
    handles.some((handle) => handle.constructor.name === 'Socket' && handle.fd === 0),
    'the SDK no longer leaks stdin on a failed spawn — drop --test-force-exit from the mcp suite',
  )
})
