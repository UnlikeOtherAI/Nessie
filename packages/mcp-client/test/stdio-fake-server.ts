/**
 * Standalone stdio MCP server used by `stdio.test.ts`. Spawned as a child
 * process via `node --import tsx`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

async function main(): Promise<void> {
  const echoDelayMs = Number(process.env.NESSIE_FAKE_ECHO_DELAY_MS ?? '0')
  const server = new McpServer({ name: 'fake-mcp', version: '0.0.0' })
  server.registerTool(
    'echo',
    {
      description: 'Echo input.',
      inputSchema: { message: z.string() },
    },
    async (args) => {
      if (echoDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, echoDelayMs))
      }
      return { content: [{ type: 'text', text: String(args.message ?? '') }] }
    },
  )
  server.registerTool(
    'add',
    {
      description: 'Add.',
      inputSchema: { a: z.number(), b: z.number() },
    },
    async (args) => ({
      content: [{ type: 'text', text: String(args.a + args.b) }],
    }),
  )
  await server.connect(new StdioServerTransport())
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('stdio fake server failed', err)
  process.exit(1)
})
