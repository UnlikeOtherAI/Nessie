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

test('a real Kelpie screenshot leaves the result as one kept image before it is measured', async () => {
  const sessions = managerFor([serverNamed('kelpie', 'kelpie')])
  try {
    const kept: Array<{ bytes: number; digest: string; mimeType: string }> = []
    const keep = async (images: readonly { bytes: Buffer; digest: string; mimeType: string }[]) => {
      for (const image of images) {
        kept.push({ bytes: image.bytes.length, digest: image.digest, mimeType: image.mimeType })
      }
    }
    const result = await sessions.callTool('kelpie', 'kelpie_screenshot', {}, keep) as {
      content: Array<Record<string, unknown>>
      structuredContent: Record<string, unknown>
      success: boolean
    }
    const digest = 'sha256:aac8eca7b74f38470cd961da4b11897e2296ca4b583865dde161ab387027e7a5'
    // Three base64 copies in, one image kept.
    assert.deepEqual(kept, [{ bytes: 13_715, digest, mimeType: 'image/png' }])
    assert.equal(result.success, true)
    assert.deepEqual(result.content[1], { attachmentDigest: digest, byteLength: 13_715, mimeType: 'image/png', type: 'image' })
    assert.equal(result.structuredContent.image, `[image: attachment ${digest}]`)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_024)

    // A page as large as Hacker News's was three copies over the whole budget.
    const large = await sessions.callTool('kelpie', 'kelpie_screenshot_large', {}, keep)
    assert.equal(large.success, true, 'no longer EXECUTOR_MCP_RESULT_TOO_LARGE')
    assert.equal(kept.at(-1)?.bytes, 200_000)

    // With nowhere to keep it, the image is withdrawn rather than referenced.
    const unkept = await sessions.callTool('kelpie', 'kelpie_screenshot') as { content: Array<Record<string, unknown>> }
    assert.deepEqual(unkept.content[1], { text: '[image unavailable: this machine has nowhere to keep images]', type: 'text' })
  } finally {
    await sessions.stopAll()
  }
})

test('an isError result is measured as returned, code and success included', async () => {
  // The failure document is 35 bytes longer than the same result marked as a
  // success. Measured before its code was added, a failure near the budget
  // passed here and was then refused by the control plane's own 64 KiB cap.
  const budget = 4_096
  const sessions = managerFor([serverNamed('scripted', 'ok')], budget)
  try {
    const returned: number[] = []
    let refused = 0
    for (let bytes = 3_960; bytes <= 4_040; bytes += 1) {
      const result = await sessions.callTool('scripted', 'boom', { bytes })
      if (result.code === 'EXECUTOR_MCP_RESULT_TOO_LARGE') {
        refused += 1
        continue
      }
      assert.equal(result.code, 'EXECUTOR_MCP_CALL_FAILED')
      returned.push(Buffer.byteLength(JSON.stringify(result)))
    }
    assert.ok(refused > 0 && returned.length > 0, 'the walk crosses the budget')
    assert.equal(Math.max(...returned), budget, 'the largest failure returned is exactly the budget')
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

test('a server’s own slow catalog pages share one deadline, never one each', async () => {
  // Each page answers inside the call timeout, the two together do not. With
  // a timeout per page the walk succeeded after both, and a cold mcp.tools
  // could outlive its command's expiry by as many timeouts as the server had
  // pages.
  const slow: ExecutorLocalMcpServer = {
    command: [process.execPath, SCRIPT],
    env: { NESSIE_TEST_MCP_MODE: 'slow-pages', NESSIE_TEST_MCP_PAGE_DELAY_MS: '500' },
    name: 'scripted',
  }
  const cut = createExecutorMcpSessionManager([slow], { maxResultBytes: 65_536 }, {
    callTimeoutMs: 800,
    log: () => undefined,
    startTimeoutMs: 15_000,
  })
  try {
    const result = await cut.listTools('scripted') as { code?: string; success: boolean }
    assert.equal(result.success, false)
    assert.equal(result.code, 'EXECUTOR_MCP_UNAVAILABLE')
  } finally {
    await cut.stopAll()
  }

  // The same server inside a deadline that fits both pages lists them all.
  const roomy = createExecutorMcpSessionManager([slow], { maxResultBytes: 65_536 }, {
    callTimeoutMs: 5_000,
    log: () => undefined,
    startTimeoutMs: 15_000,
  })
  try {
    const result = await roomy.listTools('scripted') as { catalog: { tools: { name: string }[] }; success: boolean }
    assert.equal(result.success, true)
    assert.deepEqual(result.catalog.tools.map((tool) => tool.name), ['echo', 'boom'])
  } finally {
    await roomy.stopAll()
  }
})

test('a command does not wait behind a background probe’s catalog read', async () => {
  // The reporter probes every server on its own cadence. A command's expiry
  // budgets a cold start and its own call, so a probe that held the session
  // queue through a slow tools/list left the command that much less time.
  const slow: ExecutorLocalMcpServer = {
    command: [process.execPath, SCRIPT],
    env: { NESSIE_TEST_MCP_MODE: 'slow-pages', NESSIE_TEST_MCP_PAGE_DELAY_MS: '1500' },
    name: 'scripted',
  }
  const sessions = createExecutorMcpSessionManager([slow], { maxResultBytes: 65_536 }, {
    log: () => undefined,
    startTimeoutMs: 15_000,
  })
  try {
    // A call starts the session and reads no catalog, so the probe must.
    assert.equal((await sessions.callTool('scripted', 'echo', { value: 'warm' })).success, true)
    const probing = sessions.probe('scripted')
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    const started = Date.now()
    const called = await sessions.callTool('scripted', 'echo', { value: 'now' })
    const waited = Date.now() - started
    assert.equal(called.success, true)
    assert.ok(waited < 1_200, `the call went ahead of the probe's two 1.5 s pages, waited ${waited} ms`)
    // The probe queued again behind it and still reports the whole catalog.
    const probed = await probing
    assert.equal(probed.available, true)
    assert.equal(probed.available && probed.toolCount, 2)
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
