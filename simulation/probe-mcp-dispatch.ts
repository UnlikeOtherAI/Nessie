/**
 * MCP dispatch round-trip probe.
 *
 * Boots the local MCP fixture (`mcp-fixture-server`), invokes `dispatchTool`
 * against it, asserts the echo round-trip succeeds. Proves the worker's MCP
 * plumbing is intact end-to-end without needing a running api/worker/postgres.
 *
 * Pair with `probe-kimi-tools.ts` (LLM tool calls) and the live simulation
 * (full agentic loop) to cover the three legs of the `delegate` feature.
 */

import { startMcpFixture } from '../packages/mcp-client/test/fixtures/mcp-fixture-server.ts'
import { dispatchTool } from '../worker/dist/run/tool-dispatch.js'

const main = async (): Promise<void> => {
  const fixture = await startMcpFixture(0)
  console.log(`[probe] mcp fixture at ${fixture.url}`)

  try {
    const echoResult = await dispatchTool({
      spec: {
        transport: 'mcp',
        connection: { transport: 'http', url: fixture.url },
        toolName: 'echo',
      },
      args: { text: 'sub-agent says hi' },
    })

    console.log('echo success:', echoResult.success)
    console.log('echo output:', echoResult.output)

    if (!echoResult.success) {
      console.error('FAIL: echo returned success=false')
      process.exitCode = 2
      return
    }
    if (!echoResult.output.includes('sub-agent says hi')) {
      console.error('FAIL: echo output did not contain expected text')
      process.exitCode = 2
      return
    }

    const addResult = await dispatchTool({
      spec: {
        transport: 'mcp',
        connection: { transport: 'http', url: fixture.url },
        toolName: 'fixture_add',
      },
      args: { a: 17, b: 25 },
    })

    console.log('add success:', addResult.success)
    console.log('add output:', addResult.output)

    if (!addResult.success || !addResult.output.includes('42')) {
      console.error('FAIL: fixture_add did not return 42')
      process.exitCode = 2
      return
    }

    console.log('\nPASS — MCP dispatch round-trip verified')
  } finally {
    await fixture.close()
  }
}

await main()
